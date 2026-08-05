/**
 * pi-memory — Internal helpers (pure functions, no PI dependency).
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

export const MEMORIES_ROOT = join(homedir(), ".pi", "agent", "memories");
export const OBSERVATION_THRESHOLD = 50;

/**
 * Token budgets for observation fields (approx, ~4 chars/token).
 * Equivalent to ~4000 chars prompt, ~8000 chars response, ~2000 chars per tool result.
 */
export const OBSERVATION_TOKEN_BUDGETS = {
	prompt: 1000,
	response: 2000,
	toolResult: 500,
} as const;

/** Approximate chars per token for size estimation (English-centric heuristic). */
export const CHARS_PER_TOKEN = 4;

/**
 * Token budget of observations per memory_extract call (incremental batch).
 * ~7-8 typical observations (~4K tokens each); total prompt stays ~40K with
 * overhead, safe for models with >= 64K context.
 */
export const EXTRACT_BATCH_TOKEN_BUDGET = 30_000;

/** Max consecutive memory_search calls with no results before the model abandons. */
export const MAX_MEMORY_SEARCH_ATTEMPTS = 3;

export const MEMORY_TYPES = ["_rules", "decisions", "gotchas", "lessons", "patterns"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

// ── Project identification ─────────────────────────────────────────────────

/**
 * Identifies the project by git remote origin.
 *
 * 1. Tries `git remote get-url origin`
 * 2. Normalizes to `host_user_repo` format (e.g. `github.com_user_repo`)
 * 3. Falls back to `__unmanaged_<cwd_hash_12>`
 */
export function identifyProject(cwd: string): string {
	try {
		const remote = execSync("git remote get-url origin", {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 3000,
		}).trim();

		// Strip protocol, auth, .git
		const normalized = remote
			.replace(/^git@/, "")
			.replace(/^https?:\/\//, "")
			.replace(/^ssh:\/\//, "")
			.replace(/\.git$/, "")
			.replace(/\/$/, "");

		return normalized.replace(/[/:]/g, "_");
	} catch {
		const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
		return `__unmanaged_${hash}`;
	}
}

// ── Directory management ──────────────────────────────────────────────────

/**
 * Returns the list of all directories that should exist for a given project.
 */
export function getMemoryDirectories(projectId: string): string[] {
	const globalDirs = MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, "_global", t));
	const supersedesGlobal = MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, ".supersedes", "_global", t));
	const projectDirs = [
		...MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, "projects", projectId, t)),
		join(MEMORIES_ROOT, "projects", projectId, "sessions"),
	];
	const supersedesProject = MEMORY_TYPES.map((t) =>
		join(MEMORIES_ROOT, ".supersedes", "projects", projectId, t),
	);

	return [MEMORIES_ROOT, ...globalDirs, ...supersedesGlobal, ...projectDirs, ...supersedesProject];
}

/**
 * Ensures all required memory directories exist.
 * Idempotent — safe to call multiple times.
 */
export function ensureDirectories(projectId: string): string[] {
	const dirs = getMemoryDirectories(projectId);
	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
	return dirs;
}

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

// ── Memory file helpers ────────────────────────────────────────────────────

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
			// String entre aspas — desescapa (\n, \", \\)
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
			// Strings sempre entre aspas — valores com ":" ou "\n" não quebram o YAML
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

// ── Memory search ─────────────────────────────────────────────────────────

/**
 * Reads the frontmatter confidence from a memory file.
 * Returns undefined if file can't be read or has no confidence.
 */
export function readFileConfidence(filePath: string): number | undefined {
	try {
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const { meta } = parseFrontmatter(content);
		const conf = meta.confidence;
		return typeof conf === "number" ? conf : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Results from a memory search.
 */
export interface SearchResult {
	/** Absolute path to the memory file */
	file: string;
	/** Matched line(s) with line numbers */
	lines: string[];
}

/**
 * Parameters for searchMemories.
 */
export interface SearchOptions {
	query: string;
	scope?: "global" | "project" | "all";
	type?: string;
	minConfidence?: number;
	limit?: number;
	/** Project id — obrigatório quando scope === "project". */
	projectId?: string;
}

/**
 * Builds a ripgrep pattern from a list of terms (OR semantics).
 * Each term is regex-escaped so plain keywords match literally
 * (e.g. "C++" matches "C++", not the regex quantifier).
 * Returns "" for empty input.
 */
export function buildSearchPattern(terms: string[]): string {
	const escaped = terms
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.filter((t) => t.trim().length > 0);
	return escaped.join("|");
}

/**
 * Searches memories via ripgrep.
 * Returns matching file paths with context lines.
 */
export function searchMemories(options: SearchOptions): SearchResult[] {
	const { query, scope = "all", type, minConfidence, limit = 10 } = options;

	// Paths raiz por escopo — .supersedes/ fica excluído naturalmente (não é
	// subpath de _global nem projects), sem glob de exclusão frágil.
	// scope=all = global + projeto ATUAL: memórias de outros projetos são
	// específicas de cada projeto e não devem vazar para a sessão atual.
	let searchPaths: string[];
	if (scope === "global") {
		searchPaths = [join(MEMORIES_ROOT, "_global")];
	} else {
		if (!options.projectId) {
			throw new Error("searchMemories: projectId é obrigatório para scope=project/all");
		}
		const projectPath = join(MEMORIES_ROOT, "projects", options.projectId);
		searchPaths =
			scope === "all"
				? [join(MEMORIES_ROOT, "_global"), projectPath]
				: [projectPath];
	}

	// Paths inexistentes (projeto novo sem memórias) fariam o rg reclamar no
	// stderr e sair com status 2 — descartaria resultados válidos dos demais.
	searchPaths = searchPaths.filter((p) => existsSync(p));
	if (searchPaths.length === 0) return [];

	// --iglob: case-insensitive também nos globs de path (arquivos criados à
	// mão podem ter maiúsculas). Sessions é a única exclusão (fica sob projects/).
	const rgArgs: string[] = ["--no-heading", "--line-number", "-i"];
	rgArgs.push("--iglob", type ? `**/${type}/*.md` : "**/*.md");
	rgArgs.push("--glob", "!**/sessions/**");

	rgArgs.push("--", query, ...searchPaths);

	let stdout: string;
	try {
		const result = spawnSync("rg", rgArgs, {
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10000,
		});
		if (result.error) throw result.error;
		if (result.status === null) throw new Error("rg process failed to spawn");
		if (result.status === 1) return []; // no matches (rg exit code 1)
		if (result.status !== 0) {
			throw new Error(`rg exited ${result.status}: ${result.stderr}`);
		}
		stdout = result.stdout ?? "";
	} catch (e: unknown) {
		// rg not installed?
		const msg = (e as Error).message ?? String(e);
		if (msg.includes("ENOENT")) throw new Error("rg (ripgrep) not found — install with: apt install ripgrep");
		if (msg.includes("rg exited")) throw e;
		if ((e as { status?: number }).status === 1) return [];
		throw e;
	}

	if (!stdout.trim()) return [];

	// Parse output: file:line:content
	// Group by file
	const fileMap = new Map<string, string[]>();
	for (const line of stdout.trim().split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const filePath = line.slice(0, idx);
		const rest = line.slice(idx + 1);

		// The rest may have multiple colons (line:content)
		const lineEnd = rest.indexOf(":");
		if (lineEnd === -1) continue;
		const fileLine = rest.slice(0, lineEnd);
		const content = rest.slice(lineEnd + 1);

		if (!fileMap.has(filePath)) {
			fileMap.set(filePath, []);
		}
		fileMap.get(filePath)!.push(`L${fileLine}: ${content.trim()}`);
	}

	// Build results, filter by confidence, sort, limit
	const results: SearchResult[] = [];
	for (const [file, lines] of fileMap) {
		if (minConfidence !== undefined) {
			const conf = readFileConfidence(file);
			if (conf === undefined || conf < minConfidence) continue;
		}
		results.push({ file, lines });
	}

	return results.slice(0, limit);
}

// ── Memory save (shared) ──────────────────────────────────────────────────

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
} {
	const { type, context, title, content, scope, tags = [], confidence = 0.5, supersedes, mode = "append" } = params;
	const now = formatDateTime();
	const today = now.slice(0, 10);

	// Guard defensivo: type inválido criaria um diretório novo no lugar errado
	// (ex.: "gotcha" singular em vez de "gotchas") e geraria memórias órfãs.
	if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
		return {
			action: "error",
			file: "",
			error: `Invalid memory type "${type}" (expected one of: ${MEMORY_TYPES.join(", ")})`,
		};
	}

	// Handle supersede: move old memory to .supersedes/
	// Busca em TODOS os types/scopes (findMemoryFile) — a contradição
	// normalmente cruza type (ex.: lesson supersede pattern). Olhar só o
	// type+scope do novo save resultaria em no-op silencioso.
	if (supersedes) {
		const oldPath = findMemoryFile(projectId, supersedes);
		if (oldPath) {
			moveToSupersedes(oldPath, { superseded_by: context });
		}
	}

	// Consolidate: arquiva a versão atual do MESMO contexto antes de criar a
	// nova — merge-in-place via .supersedes (histórico preservado, arquivo
	// sempre limpo, confidence sem distorção de médias acumuladas).
	let consolidated = false;
	if (mode === "consolidate") {
		const ownPath = getMemoryFilePath(projectId, type, context, scope);
		if (existsSync(ownPath)) {
			moveToSupersedes(ownPath, {
				superseded_by: context,
				superseded_reason: "consolidated",
			});
			consolidated = true;
		}
	}

	const filePath = getMemoryFilePath(projectId, type, context, scope);
	ensureFileDir(filePath);

	const entry = formatMemoryEntry(now, title, content, confidence);

	if (!existsSync(filePath)) {
		// Create new file
		const meta: Record<string, unknown> = {
			context,
			type,
			created: today,
			updated: today,
			confidence,
			entries: 1,
		};
		if (tags.length > 0) meta.tags = tags;

		writeFileSync(filePath, formatFrontmatter(meta) + entry + "\n");
		return {
			action: consolidated ? "consolidated" : "created",
			file: filePath,
		};
	}

	// Append to existing file
	const existing = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(existing);
	// Média ponderada real: currentConf é a média das `entries` atuais (e já
	// reflete decays). (currentConf * N + nova) / (N+1) converge para a média
	// exata — a média sucessiva (a+b)/2 distorceria em direção à entrada mais
	// recente. Recalcular a partir do body faria o decay evaporar no append.
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

	writeFileSync(filePath, formatFrontmatter(meta) + body + entry + "\n");
	return { action: "appended", file: filePath, entries: meta.entries as number };
}

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
	existingContexts?: { global: string[]; project: string[] },
): string {
	const contextLines: string[] = [];
	if (existingContexts) {
		contextLines.push(
			"",
			"Existing memory context keys (reuse them — do NOT create new keys for the same topic):",
			`global: ${existingContexts.global.join(", ") || "(none)"}`,
			`project: ${existingContexts.project.join(", ") || "(none)"}`,
		);
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
		"- Reuse existing context keys when the topic already has a memory (see 'Existing memory context keys' below).",
		"- If new information contradicts an existing memory, pass its context key in 'supersedes'.",
		"- If a new memory UPDATES or CONTRADICTS an existing memory with the SAME context key, set 'mode': 'consolidate' — the old version is archived to .supersedes/ and the memory is rewritten fresh (merge-in-place, no append growth).",
		"- If a new memory merely COMPLEMENTS an existing one, omit 'mode' (defaults to append).",
		"- Write rich, self-contained markdown content — not atomic notes.",
		"- scope 'global' only for things that apply to ALL projects.",
		"- scope 'project' for things specific to this project.",
		"- '[truncated: ~N tokens omitted]' markers mean data was cut for size — treat the observation as partial; never fabricate content beyond the marker.",
		"",
		"Respond with JSON only, no markdown fences:",
		'{"memories": [{"type": "gotchas|_rules|decisions|lessons|patterns", "context": "short-key", "title": "concise title", "content": "rich markdown", "scope": "global|project", "confidence": 0.5, "tags": ["tag"], "mode": "append|consolidate (optional)", "supersedes": "existing-context-key (optional)"}]}',
		...contextLines,
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
				(mode === undefined || mode === "append" || mode === "consolidate")
			);
		});
	} catch {
		return [];
	}
}
		
