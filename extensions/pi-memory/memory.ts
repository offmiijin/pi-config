/**
 * pi-memory — Memory file CRUD + index + save (no PI dependency).
 *
 * File paths, frontmatter, entries, supersede, memory index/summaries and the
 * shared saveMemory used by memory_save and memory_extract.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT, MEMORY_TYPES } from "./constants.ts";
import { ensureFileDir, formatDateTime } from "./session.ts";

/**
 * Sanitizes a string to be safe for use as a filename.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses multiple hyphens.
 */
export function sanitizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Returns the file path for a memory given scope, type and context.
 */
export function getMemoryFilePath(
	projectId: string,
	type: string,
	context: string,
	scope: "global" | "project",
): string {
	const filename = `${sanitizeFilename(context)}.md`;
	if (scope === "global") {
		return join(MEMORIES_ROOT, "_global", type, filename);
	}
	return join(MEMORIES_ROOT, "projects", projectId, type, filename);
}

/**
 * Returns the .supersedes/ path for a given memory file path.
 */
export function getSupersedesPath(originalPath: string): string {
	const relative = originalPath.startsWith(MEMORIES_ROOT + "/")
		? originalPath.slice(MEMORIES_ROOT.length + 1)
		: originalPath;
	return join(MEMORIES_ROOT, ".supersedes", relative);
}

/**
 * Moves a memory file to .supersedes/, preserving structure and adding
 * superseded metadata. The original file is removed.
 * Returns the new path.
 */
export function moveToSupersedes(
	filePath: string,
	extraMeta: Record<string, unknown> = {},
): string {
	const content = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(content);

	meta.superseded_at = new Date().toISOString().slice(0, 10);
	meta.confidence = 0;
	for (const [k, v] of Object.entries(extraMeta)) {
		meta[k] = v;
	}

	const supPath = getSupersedesPath(filePath);
	ensureFileDir(supPath);
	writeFileSync(supPath, formatFrontmatter(meta) + body);
	rmSync(filePath, { force: true });
	return supPath;
}

/**
 * Finds the memory file for a context across all types and scopes.
 * Returns undefined if not found.
 */
export function findMemoryFile(
	projectId: string,
	context: string,
): string | undefined {
	for (const scope of ["global", "project"] as const) {
		for (const type of MEMORY_TYPES) {
			const fp = getMemoryFilePath(projectId, type, context, scope);
			if (existsSync(fp)) return fp;
		}
	}
	return undefined;
}

/**
 * Lists existing memory context keys for a project (global + project scopes).
 * Used by memory_extract so the LLM can reuse existing keys and supersede.
 */
export function listMemoryContexts(projectId: string): {
	global: string[];
	project: string[];
} {
	const globalKeys: string[] = [];
	const projectKeys: string[] = [];

	for (const type of MEMORY_TYPES) {
		for (const dir of [
			join(MEMORIES_ROOT, "_global", type),
			join(MEMORIES_ROOT, "projects", projectId, type),
		]) {
			if (!existsSync(dir)) continue;
			const isGlobal = dir.includes("_global");
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				const key = f.slice(0, -3);
				if (isGlobal) globalKeys.push(key);
				else projectKeys.push(key);
			}
		}
	}

	return { global: globalKeys.sort(), project: projectKeys.sort() };
}

/**
 * One memory entry in the session index / extract dedup context.
 */
export interface MemoryIndexEntry {
	scope: "global" | "project";
	type: MemoryType;
	context: string;
	/** Title of the most recent entry in the body. */
	title: string;
	confidence: number;
	updated: string;
	/** Persisted summary (frontmatter), if any. */
	summary?: string;
	/** Raw excerpt from the end of the body (fallback when no summary). */
	excerpt: string;
}

/** Extracts the title of the LAST entry from a memory body. */
export function extractLastEntryTitle(body: string): string | undefined {
	const matches = [...body.matchAll(/^## \[[^\]]+\]\s+(.+)$/gm)];
	if (matches.length === 0) return undefined;
	return matches[matches.length - 1][1].trim();
}

/** Raw excerpt from the end of the body (append adds newest entries last). */
function extractExcerpt(body: string, maxChars = 150): string {
	const clean = body
		.replace(/^## \[[^\]]+\][^\n]*\n/g, "")
		.replace(/^confidence:.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (clean.length <= maxChars) return clean;
	return clean.slice(-maxChars).trimStart() + "…";
}

/**
 * Lists all memories (global + project) with metadata, sorted by updated desc.
 * Reads frontmatter (confidence, updated, summary) + last entry title.
 */
export function listMemoryIndex(projectId: string): MemoryIndexEntry[] {
	const entries: MemoryIndexEntry[] = [];
	for (const scope of ["global", "project"] as const) {
		for (const type of MEMORY_TYPES) {
			const dir =
				scope === "global"
					? join(MEMORIES_ROOT, "_global", type)
					: join(MEMORIES_ROOT, "projects", projectId, type);
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				const context = f.slice(0, -3);
				const filePath = join(dir, f);
				try {
					const content = readFileSync(filePath, "utf-8");
					const { meta, body } = parseFrontmatter(content);
					entries.push({
						scope,
						type,
						context,
						title: extractLastEntryTitle(body) ?? context,
						confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
						updated: typeof meta.updated === "string" ? meta.updated : "",
						...(typeof meta.summary === "string" ? { summary: meta.summary } : {}),
						excerpt: extractExcerpt(body),
					});
				} catch {
					// Corrupted file — ignore, don't break the index.
				}
			}
		}
	}
	return entries.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

/** Formats per-scope counts by type in fixed MEMORY_TYPES order, never omitting 0. */
function formatCountsByScope(entries: MemoryIndexEntry[]): string[] {
	const lines: string[] = [];
	for (const scope of ["global", "project"] as const) {
		const counts = MEMORY_TYPES.map((t) => {
			const n = entries.filter((e) => e.scope === scope && e.type === t).length;
			return `${t} (${n} memories)`;
		});
		lines.push(`  ${scope === "global" ? "_global" : "project"}: ${counts.join(", ")}`);
	}
	return lines;
}

/**
 * Formats the memory index injected once per session (before_agent_start).
 * Total always; 15 most recent; rest summarized by scope+type; full counts.
 */
export function formatMemoryIndexText(entries: MemoryIndexEntry[]): string {
	const total = entries.length;
	const lines: string[] = [];
	lines.push(`[pi-memory] Memory index (total: ${total} — call memory_search for details):`);
	lines.push("");
	lines.push("Most recent 15:");

	const recent = entries.slice(0, 15);
	if (recent.length === 0) {
		lines.push("  (none yet — call memory_save when you learn something durable)");
	} else {
		for (const e of recent) {
			lines.push(
				`  ${e.scope}/${e.type}/${e.context} (${e.confidence}, ${e.updated}): "${e.title}"`,
			);
		}
	}

	const rest = entries.slice(15);
	if (rest.length > 0) {
		lines.push("");
		lines.push(`${rest.length} not shown — by scope:`);
		lines.push(...formatCountsByScope(rest));
	}

	lines.push("");
	lines.push("Counts by scope (all):");
	lines.push(...formatCountsByScope(entries));
	return lines.join("\n");
}

/**
 * Builds the 'Existing memories' block for the extraction prompt.
 * Uses the persisted summary when available; falls back to title + excerpt.
 */
export function summarizeExistingMemories(projectId: string): string {
	const entries = listMemoryIndex(projectId);
	const lines: string[] = [
		"Existing memories (reuse context keys; 'mode: consolidate' if new info updates/contradicts the SAME key; 'supersedes' if it replaces a DIFFERENT key):",
		"",
	];
	if (entries.length === 0) {
		lines.push("  (none)");
		return lines.join("\n");
	}
	for (const e of entries) {
		const text = e.summary ? e.summary : `${e.title} — ${e.excerpt}`;
		lines.push(
			`  ${e.scope}/${e.type}/${e.context} (${e.confidence}, updated ${e.updated}): "${text}"`,
		);
	}
	return lines.join("\n");
}

/**
 * Applies a decay delta to a confidence value, clamped at 0.
 * Delta is treated as a reduction regardless of sign.
 */
export function applyDecay(currentConfidence: number, delta: number): number {
	return Math.max(0, Math.round((currentConfidence - Math.abs(delta)) * 100) / 100);
}

/**
 * Parses YAML frontmatter from a markdown file.
 * Returns metadata and body content separately.
 */
export function parseFrontmatter(content: string): {
	meta: Record<string, unknown>;
	body: string;
} {
	if (!content.startsWith("---\n")) return { meta: {}, body: content };

	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return { meta: {}, body: content };

	const yaml = content.slice(4, endIdx);
	const body = content.slice(endIdx + 5);

	const meta: Record<string, unknown> = {};
	for (const line of yaml.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^(\w+):\s*(.*)$/);
		if (!match) continue;

		let value: unknown = match[2].trim();

		// Array: ["a", "b"]
		if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
		} else if (
			typeof value === "string" &&
			value.startsWith('"') &&
			value.endsWith('"')
		) {
			// Quoted string — unescape (\n, \", \\)
			value = value
				.slice(1, -1)
				.replace(/\\n/g, "\n")
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, "\\");
		} else if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (typeof value === "string" && !isNaN(Number(value))) value = Number(value);

		meta[match[1]] = value;
	}

	return { meta, body };
}

/** Escapes a string as a YAML double-quoted scalar. */
function yamlQuoteString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Formats metadata as YAML frontmatter string.
 */
export function formatFrontmatter(meta: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(meta)) {
		if (Array.isArray(value)) {
			lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
		} else if (typeof value === "number") {
			lines.push(`${key}: ${value}`);
		} else if (typeof value === "boolean") {
			lines.push(`${key}: ${value}`);
		} else {
			// Strings always quoted — values with ":" or "\n" don't break YAML
			lines.push(`${key}: ${yamlQuoteString(String(value))}`);
		}
	}
	lines.push("---");
	return lines.join("\n") + "\n";
}

/**
 * Formats a memory entry as markdown.
 */
export function formatMemoryEntry(
	date: string,
	title: string,
	content: string,
	confidence?: number,
): string {
	const lines: string[] = [];
	if (confidence !== undefined) {
		lines.push(`## [${date}] ${title}`);
		lines.push(`confidence: ${confidence}`);
	} else {
		lines.push(`## [${date}] ${title}`);
	}
	lines.push("");
	lines.push(content.trim());
	lines.push("");
	return lines.join("\n");
}

/**
 * Extracts confidence values from all entries in a memory file body.
 */
export function extractEntryConfidences(body: string): number[] {
	const confidences: number[] = [];
	const regex = /^confidence:\s*([\d.]+)$/gm;
	let match;
	while ((match = regex.exec(body)) !== null) {
		const val = parseFloat(match[1]);
		if (!isNaN(val)) confidences.push(val);
	}
	return confidences;
}

/**
 * Recalculates the overall confidence as average of all entry confidences,
 * falling back to the provided default if no entries have explicit confidence.
 */
export function recalcOverallConfidence(
	existingConfidences: number[],
	newConfidence: number,
): number {
	const all = [...existingConfidences, newConfidence];
	if (all.length === 0) return 0.5;
	const sum = all.reduce((a, b) => a + b, 0);
	return Math.round((sum / all.length) * 100) / 100;
}

/**
 * Input parameters for saveMemory.
 */
export interface SaveMemoryParams {
	type: string;
	context: string;
	title: string;
	content: string;
	scope: "global" | "project";
	tags?: string[];
	confidence?: number;
	supersedes?: string;
	/**
	 * Concise summary (1-2 sentences, PT-BR) of the CURRENT state of the
	 * memory. Persisted in the frontmatter and overwritten on every
	 * append/consolidate when provided. Used by memory_extract for dedup.
	 */
	summary?: string;
	/**
	 * append (default): adds a dated entry to the file (backward compatible).
	 * consolidate: rewrites the memory — archives the current version to
	 * .supersedes/ and creates a fresh file (use when the new content updates
	 * or contradicts the existing memory with the SAME context key; to replace
	 * a memory under a DIFFERENT context key, use supersedes).
	 */
	mode?: "append" | "consolidate";
}

/**
 * Saves or updates a memory file. Shared by memory_save and memory_extract.
 *
 * - New context → creates file with frontmatter + first entry
 * - Existing context → appends entry, updates frontmatter (entries, confidence, tags)
 * - supersedes → moves old memory to .supersedes/ first
 * - mode "consolidate" → archives the current version of the SAME context to
 *   .supersedes/ and creates a fresh file (merge-in-place, no append growth)
 */
export function saveMemory(
	projectId: string,
	params: SaveMemoryParams,
): {
	action: "created" | "appended" | "consolidated" | "error";
	file: string;
	entries?: number;
	error?: string;
	/** Paths absolutos arquivados em .supersedes/ por supersedes|consolidate. */
	archived: string[];
} {
	const { type, context, title, content, scope, tags = [], confidence = 0.5, supersedes, mode = "append", summary } = params;
	const now = formatDateTime();
	const today = now.slice(0, 10);
	// Paths movidos para .supersedes/ nesta chamada — o índice SQLite precisa
	// removê-los da FTS (memória antiga não pode continuar buscável).
	const archived: string[] = [];

	// Defensive guard: invalid type would create a directory in the wrong place
	// (e.g. "gotcha" singular instead of "gotchas") and produce orphan memories.
	if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
		return {
			action: "error",
			file: "",
			error: `Invalid memory type "${type}" (expected one of: ${MEMORY_TYPES.join(", ")})`,
			archived,
		};
	}

	// Search ALL types/scopes (findMemoryFile) — the contradiction usually
	// crosses type (e.g. lesson supersede pattern). Looking only at the
	// new save's type+scope would result in a silent no-op.
	if (supersedes) {
		const oldPath = findMemoryFile(projectId, supersedes);
		if (oldPath) {
			moveToSupersedes(oldPath, { superseded_by: context });
			archived.push(oldPath);
		}
	}

	// Consolidate: archive the current version of the SAME context before creating
	// the new one — merge-in-place via .supersedes (history preserved, file
	// always clean, confidence without accumulated-mean distortion).
	let consolidated = false;
	if (mode === "consolidate") {
		const ownPath = getMemoryFilePath(projectId, type, context, scope);
		if (existsSync(ownPath)) {
			moveToSupersedes(ownPath, {
				superseded_by: context,
				superseded_reason: "consolidated",
			});
			archived.push(ownPath);
			consolidated = true;
		}
	}

	const filePath = getMemoryFilePath(projectId, type, context, scope);
	ensureFileDir(filePath);

	const entry = formatMemoryEntry(now, title, content, confidence);

	if (!existsSync(filePath)) {
		const meta: Record<string, unknown> = {
			context,
			type,
			created: today,
			updated: today,
			confidence,
			entries: 1,
		};
		if (tags.length > 0) meta.tags = tags;
		if (summary) meta.summary = summary;

		writeFileSync(filePath, formatFrontmatter(meta) + entry + "\n");
		return {
			action: consolidated ? "consolidated" : "created",
			file: filePath,
			archived,
		};
	}

	const existing = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(existing);
	// Real weighted average: currentConf is the mean of the current entries (and
	// already reflects decays). (currentConf * N + new) / (N+1) converges to the
	// exact mean — successive averaging (a+b)/2 would skew toward the most
	// recent entry. Recomputing from the body would make decay vanish on append.
	const currentConf = typeof meta.confidence === "number" ? meta.confidence : 0.5;
	const currentEntries = (meta.entries as number) || extractEntryConfidences(body).length || 1;
	const newOverall = Math.round(((currentConf * currentEntries + confidence) / (currentEntries + 1)) * 100) / 100;

	meta.updated = today;
	meta.confidence = newOverall;
	meta.entries = currentEntries + 1;

	if (tags.length > 0) {
		const existingTags = (meta.tags as string[]) || [];
		meta.tags = [...new Set([...existingTags, ...tags])];
	}

	// Summary always reflects the CURRENT state — overwrites the previous one.
	if (summary) meta.summary = summary;

	writeFileSync(filePath, formatFrontmatter(meta) + body + entry + "\n");
	return { action: "appended", file: filePath, entries: meta.entries as number, archived };
}
