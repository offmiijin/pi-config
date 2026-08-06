/**
 * pi-memory — Session observation lifecycle (no PI dependency).
 *
 * Session hashing, observation formatting/counting, turn dedup, token
 * estimation and session file management. Imports constants + project setup
 * from constants.ts.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	CHARS_PER_TOKEN,
	MEMORIES_ROOT,
	OBSERVATION_THRESHOLD,
	OBSERVATION_TOKEN_BUDGETS,
} from "./constants.ts";

/**
 * Generates a short stable hash from a session file path.
 */
export function hashSessionFile(sessionFile: string): string {
	return createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
}

/**
 * Generates a random session hash (for ephemeral sessions without a file).
 */
export function generateSessionHash(): string {
	return createHash("sha256")
		.update(`${Date.now()}_${Math.random()}`)
		.digest("hex")
		.slice(0, 12);
}

// ── Session observation helpers ────────────────────────────────────────────

/**
 * Returns the path to the session file for a given project, date and hash.
 *
 * @param projectId   Project identifier
 * @param sessionHash 12-char session hash
 * @param date        Date string in YYYY-MM-DD format (defaults to today)
 */
export function getSessionFilePath(projectId: string, sessionHash: string, date?: string): string {
	const d = date ?? new Date().toISOString().slice(0, 10);
	return join(MEMORIES_ROOT, "projects", projectId, "sessions", d, `${sessionHash}.md`);
}

/**
 * Extracts concatenated text content from a message content array.
 * Handles both raw strings and content block arrays.
 */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		}
	}
	return parts.join("\n").trim();
}

/**
 * Extracts tool call names from a message content array.
 */
export function extractToolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	const names: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "toolCall" && typeof b.name === "string") {
			names.push(b.name);
		}
	}
	return names;
}

/**
 * Formats the current time as HH:MM:SS.
 */
export function formatTimestamp(date?: Date): string {
	const d = date ?? new Date();
	return d.toTimeString().slice(0, 8);
}

/**
 * Formats the current local datetime as YYYY-MM-DD HH:MM:SS.
 */
export function formatDateTime(date?: Date): string {
	const d = date ?? new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A tool call with its result, as recorded in an observation.
 */
export interface ToolObservation {
	name: string;
	result?: string;
	isError?: boolean;
}

/**
 * A tool call reference extracted from an assistant message.
 */
export interface ToolCallRef {
	id: string;
	name: string;
}

/**
 * Extracts tool calls (id + name) from an assistant message content array.
 */
export function extractToolCalls(content: unknown): ToolCallRef[] {
	if (!Array.isArray(content)) return [];

	const calls: ToolCallRef[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "toolCall" && typeof b.name === "string") {
			calls.push({ id: typeof b.id === "string" ? b.id : "", name: b.name });
		}
	}
	return calls;
}

/**
 * Extracts readable text from a tool result.
 * Handles strings, content block arrays, and common result shapes.
 */
export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";

	const r = result as Record<string, unknown>;

	// Content blocks: { content: [{ type: "text", text }] }
	if (Array.isArray(r.content)) {
		return extractTextContent(r.content);
	}
	// Direct text field
	if (typeof r.text === "string") return r.text;
	// Bash-style output field
	if (typeof r.output === "string") return r.output;

	return "";
}

// ── Turn dedup (turn_end duplication guard) ─────────────────────────────────

/**
 * Persistent state for turn dedup (reset per session).
 */
export interface TurnDedupState {
	lastTurnIndex: number | undefined;
	lastFingerprint: string;
}

export function createTurnDedupState(): TurnDedupState {
	return { lastTurnIndex: undefined, lastFingerprint: "" };
}

/**
 * Builds a fingerprint of an assistant message: sorted tool call ids + text.
 * Re-emitted turn_end events for the same turn produce the same fingerprint.
 */
export function buildTurnFingerprint(content: unknown): string {
	const ids = extractToolCalls(content)
		.map((tc) => tc.id)
		.sort()
		.join(",");
	return `${ids}|${extractTextContent(content)}`;
}

/**
 * Decides whether a turn_end event is a duplicate of the last processed turn.
 * Uses event.turnIndex (unique per turn) when available; falls back to the
 * content fingerprint otherwise. Functional — returns the updated state.
 */
export function nextTurnDedup(
	turnIndex: number | undefined,
	fingerprint: string,
	state: TurnDedupState,
): { skip: boolean; state: TurnDedupState } {
	if (turnIndex !== undefined) {
		if (state.lastTurnIndex === turnIndex) return { skip: true, state };
		return {
			skip: false,
			state: { lastTurnIndex: turnIndex, lastFingerprint: fingerprint },
		};
	}
	if (fingerprint !== "" && fingerprint === state.lastFingerprint) {
		return { skip: true, state };
	}
	return { skip: false, state: { ...state, lastFingerprint: fingerprint } };
}

/**
 * Estimates the token count of a text using a chars-per-token heuristic.
 * Approximation — not a real tokenizer (~4 chars/token budget heuristic).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncates text to a maximum token budget (estimated).
 * Appends a truncation marker so the LLM knows data was cut.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
	const tokens = estimateTokens(text);
	if (tokens <= maxTokens) return text;

	const keepChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
	const kept = text.slice(0, keepChars);
	const omittedTokens = tokens - estimateTokens(kept);
	return `${kept}… [truncated: ~${omittedTokens} tokens omitted]`;
}

/**
 * Formats a single observation entry for appending to a session file.
 */
export function formatObservation(
	obsNumber: number,
	userPrompt: string,
	tools: ToolObservation[],
	agentResponse: string,
	timestamp?: Date,
): string {
	const time = formatTimestamp(timestamp);

	// Truncate long texts to keep the session file readable.
	// Token-based, with a marker so the LLM knows data was cut.
	const promptPreview = truncateToTokens(userPrompt, OBSERVATION_TOKEN_BUDGETS.prompt);
	const responsePreview = truncateToTokens(agentResponse, OBSERVATION_TOKEN_BUDGETS.response);

	const lines = [
		"",
		`## Obs #${obsNumber} (${time})`,
		`User: "${promptPreview}"`,
	];

	if (tools.length === 0) {
		lines.push("Tools: (none)");
	} else {
		lines.push("Tools:");
		for (const t of tools) {
			const resultPreview = t.result
				? truncateToTokens(t.result, OBSERVATION_TOKEN_BUDGETS.toolResult)
				: "";
			const errorMark = t.isError ? "[error] " : "";
			if (resultPreview) {
				lines.push(`  ${t.name} → ${errorMark}"${resultPreview}"`);
			} else {
				lines.push(`  ${t.name}${errorMark ? " (error)" : ""}`);
			}
		}
	}

	if (responsePreview) {
		lines.push(`Agent: "${responsePreview}"`);
	} else {
		lines.push("Agent: (no response)");
	}

	return lines.join("\n");
}

/**
 * Counts existing observations in a session file.
 * Returns 0 if file doesn't exist or has no observations.
 */
export function countObservations(filePath: string): number {
	if (!existsSync(filePath)) return 0;

	const content = readFileSync(filePath, "utf-8");
	// Anchored to line start + numeric — content containing "## Obs #"
	// (e.g. pasted markdown in user/tool text) must not inflate the count.
	const matches = content.match(/^## Obs #\d+/gm);
	return matches ? matches.length : 0;
}

/**
 * Computes the observation status for the current session.
 * Returns count, threshold and the session file path.
 */
export function getObservationStatus(
	projectId: string,
	sessionHash: string,
	date?: string,
): {
	observation_count: number;
	threshold: number;
	session_file: string;
} {
	const sessionFile = getSessionFilePath(projectId, sessionHash, date);
	const observationCount = countObservations(sessionFile);
	return {
		observation_count: observationCount,
		threshold: OBSERVATION_THRESHOLD,
		session_file: sessionFile,
	};
}

/**
 * Decides whether an extraction prompt should be emitted for the current
 * observation count, based on the last prompted bucket.
 *
 * Triggers once per threshold crossing: 50, 100, 150, ...
 *
 * @param count             current observation count
 * @param lastPromptedBucket last bucket that already triggered a prompt (-1 = none)
 * @param threshold         observation threshold
 */
export function shouldPromptExtraction(
	count: number,
	lastPromptedBucket: number,
	threshold: number = OBSERVATION_THRESHOLD,
): { prompt: boolean; bucket: number } {
	const bucket = Math.floor(count / threshold);
	return {
		prompt: count >= threshold && bucket > lastPromptedBucket,
		bucket,
	};
}

/** Tools that indicate a code change in the turn (trigger for save reminders). */
export const CODE_CHANGE_TOOLS = ["edit", "write", "apply_patch"] as const;

/** Min observations between save reminders (cooldown to avoid noise). */
export const SAVE_REMINDER_COOLDOWN = 5;

/**
 * Decides whether a save reminder should be emitted for the current observation.
 * True when the turn changed code (edit/write/apply_patch) and enough observations
 * passed since the last reminder.
 */
export function shouldRemindSave(
	toolNames: string[],
	obsNumber: number,
	lastReminderObs: number,
	cooldown: number = SAVE_REMINDER_COOLDOWN,
): boolean {
	const changedCode = toolNames.some((n) =>
		(CODE_CHANGE_TOOLS as readonly string[]).includes(n),
	);
	return changedCode && obsNumber - lastReminderObs >= cooldown;
}

/**
 * Builds the initial session file header.
 */
export function formatSessionHeader(sessionHash: string, date?: string): string {
	const d = date ?? new Date().toISOString().slice(0, 10);
	return `# Session ${sessionHash} — ${d}`;
}

/**
 * Archives the current session file content before a reset, preserving raw
 * observations for later re-extraction. Returns the archive path.
 */
export function archiveSessionFile(filePath: string): string {
	const archivePath = join(dirname(filePath), "archive", basename(filePath));
	ensureFileDir(archivePath);
	if (existsSync(filePath)) {
		copyFileSync(filePath, archivePath);
	}
	return archivePath;
}

/**
 * Resets a session file to a fresh state (header only, zero observations).
 * Keeps the same file path and session hash.
 */
export function resetSessionFile(filePath: string, sessionHash: string): void {
	ensureFileDir(filePath);
	const header = formatSessionHeader(sessionHash);
	writeFileSync(filePath, header + "\n");
}

/**
 * Ensures the directory for a file path exists, creating it if needed.
 */
export function ensureFileDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
