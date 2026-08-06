/**
 * pi-memory — LLM-assisted extraction helpers (no PI dependency).
 *
 * Session content reading, incremental batching, extraction prompt and result
 * parsing. The memory_extract tool itself lives in index.ts / tools/.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { EXTRACT_BATCH_TOKEN_BUDGET, MEMORY_TYPES } from "./constants.ts";
import { estimateTokens } from "./session.ts";

// ── Memory extraction (LLM-assisted) ───────────────────────────────────────

/**
 * Reads the content of a session file, or empty string if missing.
 */
export function readSessionContent(filePath: string): string {
	if (!existsSync(filePath)) return "";
	return readFileSync(filePath, "utf-8");
}

/**
 * Splits a session file content into individual observations.
 * The header (everything before the first "## Obs #") is dropped.
 */
export function splitObservations(content: string): string[] {
	return content
		.split(/^(?=## Obs #)/gm)
		.map((p) => p.trim())
		.filter((p) => p.startsWith("## Obs #"));
}

/**
 * Selects the largest prefix of observations that fits the token budget,
 * guaranteeing at least one observation. Used for incremental extraction.
 */
export function selectObservationsBatch(
	observations: string[],
	maxTokens: number = EXTRACT_BATCH_TOKEN_BUDGET,
): { batch: string[]; remaining: string[] } {
	let total = 0;
	let idx = 0;
	for (const obs of observations) {
		const t = estimateTokens(obs);
		if (total + t > maxTokens) break;
		total += t;
		idx++;
	}
	// Nunca retorna lote vazio quando há observações (uma obs gigante não pode
	// ser quebrada em pedaços menores sem perder a estrutura do arquivo).
	if (idx === 0 && observations.length > 0) idx = 1;
	return { batch: observations.slice(0, idx), remaining: observations.slice(idx) };
}

/**
 * Rewrites a session file without the first `processed` observations,
 * keeping the header and the remaining (unprocessed) ones.
 * No-op when the file has no observations.
 */
export function removeProcessedObservations(filePath: string, processed: number): void {
	const content = readFileSync(filePath, "utf-8");
	const obsStart = content.search(/^## Obs #/m);
	if (obsStart === -1) return;
	const header = content.slice(0, obsStart);
	const parts = content.slice(obsStart).split(/^(?=## Obs #)/gm);
	const keep = parts.slice(Math.min(processed, parts.length));
	writeFileSync(filePath, header + keep.join(""));
}

/**
 * Builds the LLM prompt that turns session observations into memories.
 */
/** Memory content language rule — memories are stored in PT-BR. */
export const MEMORY_LANGUAGE_RULE =
	"Write all memory content (title, content, tags) in PT-BR (Brazilian Portuguese).";

export function buildExtractionPrompt(
	sessionContent: string,
	existingMemories?: string,
): string {
	const memoryLines: string[] = [];
	if (existingMemories) {
		memoryLines.push("", existingMemories);
	}

	return [
		"You are extracting durable memories from a coding session log.",
		"Analyze the observations below and identify memories worth keeping:",
		'- rules — coding conventions that should always be followed',
		'- decisions — architectural or design decisions',
		'- gotchas — pitfalls, errors, traps',
		'- lessons — learnings that generalize',
		'- patterns — recurring code/design patterns',
		"",
		"Rules:",
		`- ${MEMORY_LANGUAGE_RULE}`,
		"- Only extract memories with confidence >= 0.5.",
		"- Reuse existing context keys when the topic already has a memory (see 'Existing memories' below).",
		"- If new information contradicts an existing memory, pass its context key in 'supersedes'.",
		"- If a new memory UPDATES or CONTRADICTS an existing memory with the SAME context key, set 'mode': 'consolidate' — the old version is archived to .supersedes/ and the memory is rewritten fresh (merge-in-place, no append growth).",
		"- If a new memory merely COMPLEMENTS an existing one, omit 'mode' (defaults to append).",
		"- For each memory provide a concise 'summary' (1-2 sentences in PT-BR) describing the CURRENT state of the knowledge — it is persisted in the memory frontmatter and used for future dedup.",
		"- Write rich, self-contained markdown content — not atomic notes.",
		"- scope 'global' only for things that apply to ALL projects.",
		"- scope 'project' for things specific to this project.",
		"- '[truncated: ~N tokens omitted]' markers mean data was cut for size — treat the observation as partial; never fabricate content beyond the marker.",
		"",
		"Respond with JSON only, no markdown fences:",
		'{"memories": [{"type": "gotchas|_rules|decisions|lessons|patterns", "context": "short-key", "title": "concise title", "content": "rich markdown", "summary": "1-2 sentence summary (PT-BR)", "scope": "global|project", "confidence": 0.5, "tags": ["tag"], "mode": "append|consolidate (optional)", "supersedes": "existing-context-key (optional)"}]}',
		...memoryLines,
		"",
		"<session>",
		sessionContent,
		"</session>",
	].join("\n");
}

/**
 * One extracted memory proposed by the LLM.
 */
export interface ExtractedMemory {
	type: string;
	context: string;
	title: string;
	content: string;
	scope: "global" | "project";
	confidence?: number;
	tags?: string[];
	supersedes?: string;
	summary?: string;
	/** append (default) | consolidate — merge-in-place on same context key. */
	mode?: "append" | "consolidate";
}

/**
 * Parses the LLM extraction response into memories.
 * Handles markdown code fences and filters incomplete entries.
 */
export function parseExtractionResult(jsonText: string): ExtractedMemory[] {
	try {
		const cleaned = jsonText
			.replace(/^```(?:json)?\s*/m, "")
			.replace(/\s*```$/m, "")
			.trim();
		const parsed = JSON.parse(cleaned) as { memories?: unknown };
		if (!Array.isArray(parsed.memories)) return [];

		return parsed.memories.filter((m): m is ExtractedMemory => {
			if (!m || typeof m !== "object") return false;
			const mem = m as Record<string, unknown>;
			const mode = mem.mode;
			return (
				typeof mem.type === "string" &&
				(MEMORY_TYPES as readonly string[]).includes(mem.type) &&
				typeof mem.context === "string" &&
				typeof mem.title === "string" &&
				typeof mem.content === "string" &&
				(mem.scope === "global" || mem.scope === "project") &&
				(mem.summary === undefined || typeof mem.summary === "string") &&
				(mode === undefined || mode === "append" || mode === "consolidate")
			);
		});
	} catch {
		return [];
	}
}
