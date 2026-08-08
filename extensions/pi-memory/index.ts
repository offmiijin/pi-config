/**
 * pi-memory — Memory extension for PI coding agent.
 *
 * Manages persistent memories (rules, decisions, gotchas, lessons, patterns)
 * across global and project scopes. Memories are rich markdown files grouped
 * by context, searchable via SQLite FTS5/BM25 index (ripgrep fallback).
 *
 * The LLM drives all memory operations via tools. The extension only appends
 * raw observations to the session file automatically at turn_end.
 *
 * Layout:
 *   index.ts            — extension state + event handlers (wiring)
 *   constants.ts        — shared constants + project setup
 *   session.ts          — session observation lifecycle
 *   memory.ts           — memory file CRUD + index + save
 *   memory-search.ts    — ripgrep search fallback (índice indisponível)
 *   memory-extract.ts   — LLM-assisted extraction helpers
 *   schemas.ts          — tool parameter schemas
 *   tools/*.ts          — one file per tool (status, save, search, decay, extract)
 */

import { appendFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OBSERVATION_THRESHOLD,
	ensureDirectories,
	identifyProject,
} from "./constants.ts";
import {
	buildTurnFingerprint,
	countObservations,
	createTurnDedupState,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	extractToolCalls,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	getSessionFilePath,
	hashSessionFile,
	nextTurnDedup,
	SAVE_REMINDER_COOLDOWN,
	shouldPromptExtraction,
	shouldRemindSave,
	type ToolObservation,
} from "./session.ts";
import { formatMemoryIndexText, listMemoryIndex } from "./memory.ts";
import { INDEX_DB_PATH, MemoryIndex } from "./memory-index.ts";
import { registerMemoryDecay } from "./tools/decay.ts";
import { registerMemoryExtract } from "./tools/extract.ts";
import { registerMemorySave } from "./tools/save.ts";
import { registerMemorySearch } from "./tools/search.ts";
import { registerMemoryStatus } from "./tools/status.ts";
import type { ToolState } from "./tools/state.ts";

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Shared state between event handlers and tools (tools mutate via reference)
	const state: ToolState = {
		projectId: "",
		currentSessionHash: "",
		lastPromptedBucket: -1,
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
		index: null,
	};

	// Auto-extraction trigger state (used only by event handlers)
	let extractionDueCount = 0;
	// Save reminder state (code-changing turns)
	let saveReminderDue = false;
	let lastSaveReminderObs = 0;
	// Flag: reminder sent this user turn (max 1x per turn —
	// turn_end can fire multiple times within the same turn with edits)
	let saveReminderSent = false;
	// Turn dedup (harness can fire turn_end twice for the same turn)
	let turnDedupState = createTurnDedupState();
	// Tool results buffer for the current turn (toolCallId → observation)
	const toolResultsBuffer = new Map<string, ToolObservation>();

	// ── Capture tool results during the turn ───────────────────────
	pi.on("tool_result", async (event) => {
		const e = event as unknown as {
			toolCallId?: string;
			toolName?: string;
			content?: unknown;
			isError?: boolean;
		};
		if (!e.toolCallId) return;
		toolResultsBuffer.set(e.toolCallId, {
			name: e.toolName ?? "unknown",
			result: extractTextContent(e.content),
			isError: !!e.isError,
		});
	});

	// ── Session lifecycle ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		state.projectId = identifyProject(ctx.cwd);
		ensureDirectories(state.projectId);

		const sessionFile = ctx.sessionManager.getSessionFile();
		state.currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();

		// Índice SQLite/FTS5: abre + sync incremental (rebuild automático se
		// banco novo/schema antigo). Falha de índice não derruba a sessão —
		// memory_search cai no fallback rg.
		try {
			state.index = new MemoryIndex(INDEX_DB_PATH);
			state.index.open();
			state.index.syncIncremental(state.projectId);
		} catch (err) {
			state.index = null;
			console.warn(`[pi-memory] índice indisponível: ${(err as Error).message} — busca via rg`);
		}

		// Reset auto-extraction trigger state
		state.lastPromptedBucket = -1;
		extractionDueCount = 0;
		// Reset memory search policy state
		state.consecutiveEmptySearches = 0;
		// Reset save reminder state
		saveReminderDue = false;
		lastSaveReminderObs = 0;
		saveReminderSent = false;
		// Reset session memory index cache
		state.cachedIndexText = null;
		// Reset turn dedup state
		turnDedupState = createTurnDedupState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		const nextProjectId = identifyProject(ctx.cwd);
		if (nextProjectId === state.projectId) {
			// Same project: do NOT reset trigger state. Resetting lastPromptedBucket
			// here, with an extraction followUp still pending (nextTurn), would
			// make the trigger re-fire the same bucket → duplicated message in the
			// next user prompt.
			return;
		}
		state.projectId = nextProjectId;

		// Sincroniza o índice para o novo projeto (global + projeto novo)
		if (state.index?.isOpen) {
			try {
				state.index.syncIncremental(nextProjectId);
			} catch (err) {
				console.warn(`[pi-memory] índice não sincronizado p/ ${nextProjectId}: ${(err as Error).message}`);
			}
		}

		// Reset trigger state on project change
		state.lastPromptedBucket = -1;
		extractionDueCount = 0;
		// Reset memory search policy state
		state.consecutiveEmptySearches = 0;
		// Reset save reminder state
		saveReminderDue = false;
		lastSaveReminderObs = 0;
		saveReminderSent = false;
		// Reset session memory index cache
		state.cachedIndexText = null;
		// Reset turn dedup state
		turnDedupState = createTurnDedupState();
	});

	// ── Append observations at turn_end ────────────────────────────────────
	pi.on("turn_end", async (event, ctx) => {
		if (!state.projectId || !state.currentSessionHash) return;

		const assistantMsg = event.message;
		if (!assistantMsg) return;

		const agentResponse = extractTextContent(assistantMsg.content);

		// ── Turn dedup ──
		// The harness can fire turn_end more than once for the SAME turn
		// (observed in sessions with followUps: duplicated obs, inflated count,
		// re-fired reminders/triggers). Dedup by event.turnIndex (unique index
		// per turn); fallback to content fingerprint when
		// turnIndex is unavailable.
		const fingerprint = buildTurnFingerprint(assistantMsg.content);
		const turnIndex = (event as { turnIndex?: number }).turnIndex;
		const { skip, state: nextState } = nextTurnDedup(turnIndex, fingerprint, turnDedupState);
		turnDedupState = nextState;
		if (skip) return;

		const branch = ctx.sessionManager.getBranch();

		// Find the last user prompt and collect tool results
		// from the current turn (role="toolResult" messages after the last prompt)
		let userPrompt = "";
		let lastUserIdx = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "user") {
				lastUserIdx = i;
				userPrompt = extractTextContent(entry.message.content);
				break;
			}
		}

		// Tool calls from the assistant content (source order)
		const toolCalls = extractToolCalls(assistantMsg.content);

		// This turn's results from the branch (role="toolResult" messages
		// after the last user — also in source order, as documented)
		const branchResults: ToolObservation[] = [];
		if (lastUserIdx >= 0) {
			for (let i = lastUserIdx + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message?.role === "toolResult") {
					branchResults.push({
						name: entry.message.toolName ?? "unknown",
						result: extractTextContent(entry.message.content),
						isError: !!entry.message.isError,
					});
				}
			}
		}

		// Align toolCalls[i] ↔ branchResults[i]; buffer enriches by id
		let toolResults: ToolObservation[];
		if (toolCalls.length > 0) {
			toolResults = toolCalls.map((tc, i) => {
				const buffered = toolResultsBuffer.get(tc.id);
				if (buffered && buffered.result) return buffered;
				return branchResults[i] ?? { name: tc.name };
			});
		} else {
			// No toolCall blocks in content: use branchResults directly
			toolResults =
				branchResults.length > 0
					? branchResults
					: extractToolCallNames(assistantMsg.content).map((n) => ({ name: n }));
		}
		toolResultsBuffer.clear();

		const sessionFile = getSessionFilePath(state.projectId, state.currentSessionHash);
		ensureFileDir(sessionFile);

		if (!existsSync(sessionFile)) {
			const header = formatSessionHeader(state.currentSessionHash);
			appendFileSync(sessionFile, header + "\n");
		}

		const obsNumber = countObservations(sessionFile) + 1;
		const obs = formatObservation(obsNumber, userPrompt, toolResults, agentResponse);
		appendFileSync(sessionFile, obs + "\n");

		// ── Auto-extraction trigger ──
		// Send a message to the LLM at each threshold crossing (50, 100, ...).
		// Delivered via "nextTurn" (not followUp): no intra-turn delay, no
		// extra cycle. lastPromptedBucket (monotonic) already guarantees 1x/threshold;
		// it is not reset in before_agent_start nor in session_tree for the same
		// project (prevents re-firing the same bucket with a pending message).
		const count = countObservations(sessionFile);
		const { prompt, bucket } = shouldPromptExtraction(count, state.lastPromptedBucket);
		if (prompt) {
			state.lastPromptedBucket = bucket;
			try {
				pi.sendUserMessage(
					`[pi-memory] Session reached ${count} observations (threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					{ deliverAs: "nextTurn" },
				);
			} catch {
				// Fallback: inject at the next before_agent_start
				extractionDueCount = count;
			}
		}

		// ── Memory save reminder ──
		// Turn changed code and passed the cooldown → remind the LLM to save
		// durable learning directly via memory_save (without waiting for extract).
		// Max 1x per USER turn: saveReminderSent guard is reset in
		// agent_settled (real end of prompt) — NOT in before_agent_start, which
		// also fires for extension-generated cycles and reset the
		// guard mid-turn (duplicated reminders).
		// Delivered via "nextTurn": doesn't interrupt or add an extra cycle — the
		// message arrives at the next user prompt, with no delay inside the
		// turn and no re-fire by the followUp itself.
		if (
			!saveReminderSent &&
			shouldRemindSave(
				toolResults.map((t) => t.name),
				obsNumber,
				lastSaveReminderObs,
				SAVE_REMINDER_COOLDOWN,
			)
		) {
			saveReminderSent = true;
			lastSaveReminderObs = obsNumber;
			try {
				pi.sendUserMessage(
					"[pi-memory] This turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
				{ deliverAs: "nextTurn" },
				);
			} catch {
				saveReminderDue = true;
			}
		}
	});

	// ── Inject extraction prompt + memory index at next user turn ───────────
	pi.on("before_agent_start", async (event, ctx) => {
		// NOTE: do NOT reset saveReminderSent here. before_agent_start also fires
		// for extension-generated cycles (sendUserMessage), which
		// reset the guard mid-turn and allowed duplicated reminders.
		// Reset happens in agent_settled (real end of the user prompt).

		// Memory index in the SYSTEM PROMPT (rebuilt per turn — doesn't
		// pollute the message history like the customType message did).
		// Cache per session, invalidated on writes (memory_save/extract/decay).
		const withIndex = (prompt: string): string => {
			if (!state.projectId) return prompt;
			if (state.cachedIndexText === null) {
				state.cachedIndexText = formatMemoryIndexText(listMemoryIndex(state.projectId));
			}
			return `${prompt}\n\n${state.cachedIndexText}`;
		};

		if (extractionDueCount > 0) {
			const count = extractionDueCount;
			extractionDueCount = 0;
			return {
				systemPrompt: withIndex(event.systemPrompt),
				message: {
					customType: "pi-memory",
					content:
						`[pi-memory] Session reached ${count} observations ` +
						`(threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					display: true,
				},
			};
		}
		if (saveReminderDue) {
			saveReminderDue = false;
			return {
				systemPrompt: withIndex(event.systemPrompt),
				message: {
					customType: "pi-memory",
					content:
						"[pi-memory] A recent turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
					display: true,
				},
			};
		}

		return { systemPrompt: withIndex(event.systemPrompt) };
	});

	// ── End of user prompt → allow a new reminder next turn ─────
	pi.on("agent_settled", async (_event, _ctx) => {
		// agent_settled = real end of the prompt (after retries/compaction/followUps).
		// Resetting the guard here (not in before_agent_start) guarantees at most
		// 1 reminder per USER turn, even with long tool turns.
		saveReminderSent = false;
	});

	// ── Fecha o índice SQLite no fim da sessão (WAL checkpoint) ──
	pi.on("session_shutdown", async () => {
		state.index?.close();
		state.index = null;
	});

	// ── Tools ──────────────────────────────────────────────────────────────
	registerMemoryStatus(pi, state);
	registerMemorySave(pi, state);
	registerMemorySearch(pi, state);
	registerMemoryDecay(pi, state);
	registerMemoryExtract(pi, state);
}
