/**
 * pi-memory — Memory extension for PI coding agent.
 *
 * Manages persistent memories (rules, decisions, gotchas, lessons, patterns)
 * across global and project scopes. Memories are rich markdown files grouped
 * by context, searchable via ripgrep.
 *
 * The LLM drives all memory operations via tools. The extension only appends
 * raw observations to the session file automatically at turn_end.
 *
 * Layout:
 *   index.ts            — extension state + event handlers (wiring)
 *   constants.ts        — shared constants + project setup
 *   session.ts          — session observation lifecycle
 *   memory.ts           — memory file CRUD + index + save
 *   memory-search.ts    — ripgrep search
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
import { registerMemoryDecay } from "./tools/decay.ts";
import { registerMemoryExtract } from "./tools/extract.ts";
import { registerMemorySave } from "./tools/save.ts";
import { registerMemorySearch } from "./tools/search.ts";
import { registerMemoryStatus } from "./tools/status.ts";
import type { ToolState } from "./tools/state.ts";

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Estado compartilhado entre event handlers e tools (tools mutam via referência)
	const state: ToolState = {
		projectId: "",
		currentSessionHash: "",
		lastPromptedBucket: -1,
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
	};

	// Auto-extraction trigger state (só usado pelos event handlers)
	let extractionDueCount = 0;
	// Save reminder state (code-changing turns)
	let saveReminderDue = false;
	let lastSaveReminderObs = 0;
	// Flag: reminder enviado neste turno de usuário (máx 1x por turno —
	// turn_end pode disparar várias vezes dentro do mesmo turno com edits)
	let saveReminderSent = false;
	// Dedup de turnos (harness pode disparar turn_end 2x p/ o mesmo turno)
	let turnDedupState = createTurnDedupState();
	// Buffer de resultados de tools do turno atual (toolCallId → observação)
	const toolResultsBuffer = new Map<string, ToolObservation>();

	// ── Captura resultados de tools durante o turno ───────────────────────
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
			// Mesmo projeto: NÃO resetar trigger state. Resetar lastPromptedBucket
			// aqui, com um followUp de extração ainda pendente (nextTurn), faria
			// o trigger re-disparar o mesmo bucket → mensagem duplicada no
			// próximo prompt de usuário.
			return;
		}
		state.projectId = nextProjectId;

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

		// ── Dedup de turno ──
		// O harness pode disparar turn_end mais de uma vez para o MESMO turno
		// (observado em sessões com followUps: obs duplicadas, count inflado,
		// reminders/triggers re-disparados). Dedup por event.turnIndex (índice
		// único por turno); fallback por fingerprint de conteúdo quando o
		// turnIndex não está disponível.
		const fingerprint = buildTurnFingerprint(assistantMsg.content);
		const turnIndex = (event as { turnIndex?: number }).turnIndex;
		const { skip, state: nextState } = nextTurnDedup(turnIndex, fingerprint, turnDedupState);
		turnDedupState = nextState;
		if (skip) return;

		const branch = ctx.sessionManager.getBranch();

		// Encontra o último prompt do usuário e coleta resultados de tools
		// do turno atual (mensagens role="toolResult" após o último prompt)
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

		// Tool calls do conteúdo do assistant (ordem de origem)
		const toolCalls = extractToolCalls(assistantMsg.content);

		// Resultados deste turno a partir do branch (mensagens role="toolResult"
		// após o último user — também em ordem de origem, conforme documentado)
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

		// Alinha toolCalls[i] ↔ branchResults[i]; buffer enriquece por id
		let toolResults: ToolObservation[];
		if (toolCalls.length > 0) {
			toolResults = toolCalls.map((tc, i) => {
				const buffered = toolResultsBuffer.get(tc.id);
				if (buffered && buffered.result) return buffered;
				return branchResults[i] ?? { name: tc.name };
			});
		} else {
			// Sem toolCall blocks no conteúdo: usa branchResults direto
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
		// Envia mensagem pro LLM a cada cruzamento do threshold (50, 100, ...).
		// Entrega via "nextTurn" (não followUp): sem atraso intra-turno, sem
		// ciclo extra. lastPromptedBucket (monotônico) já garante 1x/threshold;
		// não é resetado em before_agent_start nem em session_tree no mesmo
		// projeto (evita re-disparo do mesmo bucket com mensagem pendente).
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
				// Fallback: injeta no próximo before_agent_start
				extractionDueCount = count;
			}
		}

		// ── Memory save reminder ──
		// Turno alterou código e passou o cooldown → lembra o LLM de salvar
		// aprendizagem durável diretamente via memory_save (sem esperar extract).
		// Máx 1x por turno de USUÁRIO: guard saveReminderSent é resetado em
		// agent_settled (fim real do prompt) — NÃO em before_agent_start, que
		// dispara também para ciclos gerados pela própria extensão e resetava o
		// guard no meio do turno (reminders duplicados).
		// Entrega via "nextTurn": não interrompe nem gera ciclo extra — a
		// mensagem chega no próximo prompt do usuário, sem atraso dentro do
		// turno nem re-disparo pelo próprio followUp.
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
		// NOTA: NÃO resetar saveReminderSent aqui. before_agent_start dispara
		// também para ciclos gerados pela própria extensão (sendUserMessage), o
		// que resetava o guard no meio do turno e permitia reminders duplicados.
		// Reset acontece em agent_settled (fim real do prompt de usuário).

		// Índice de memórias no SYSTEM PROMPT (reconstruído por turno — não
		// polui o histórico de mensagens como a mensagem customType fazia).
		// Cache por sessão, invalidado nas escritas (memory_save/extract/decay).
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

	// ── Fim do prompt de usuário → libera novo reminder no próximo turno ─────
	pi.on("agent_settled", async (_event, _ctx) => {
		// agent_settled = fim real do prompt (após retries/compaction/followUps).
		// Reset do guard aqui (e não em before_agent_start) garante no máximo
		// 1 reminder por turno de USUÁRIO, mesmo com turnos longos de tools.
		saveReminderSent = false;
	});

	// ── Tools ──────────────────────────────────────────────────────────────
	registerMemoryStatus(pi, state);
	registerMemorySave(pi, state);
	registerMemorySearch(pi, state);
	registerMemoryDecay(pi, state);
	registerMemoryExtract(pi, state);
}
