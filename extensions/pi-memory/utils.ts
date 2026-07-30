/**
 * pi-memory — Internal helpers (pure functions, no PI dependency).
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

export const MEMORIES_ROOT = join(homedir(), ".pi", "memories");
export const OBSERVATION_THRESHOLD = 50;

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
 * Formats a single observation entry for appending to a session file.
 */
export function formatObservation(
	obsNumber: number,
	userPrompt: string,
	toolCalls: string[],
	agentResponse: string,
	timestamp?: Date,
): string {
	const time = formatTimestamp(timestamp);
	const toolsStr =
		toolCalls.length > 0 ? `Tools: ${toolCalls.join(", ")}` : "Tools: (none)";

	// Truncate long texts to keep the session file readable
	const promptPreview = userPrompt.slice(0, 1000);
	const responsePreview = agentResponse.slice(0, 2000);

	const lines = [
		"",
		`## Obs #${obsNumber} (${time})`,
		`User: "${promptPreview}"`,
		toolsStr,
	];

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
	let count = 0;
	let pos = 0;

	while (true) {
		const idx = content.indexOf("## Obs #", pos);
		if (idx === -1) break;
		count++;
		pos = idx + 8; // move past "## Obs #"
	}

	return count;
}

/**
 * Builds the initial session file header.
 */
export function formatSessionHeader(sessionHash: string, date?: string): string {
	const d = date ?? new Date().toISOString().slice(0, 10);
	return `# Session ${sessionHash} — ${d}`;
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
		} else if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (typeof value === "string" && !isNaN(Number(value))) value = Number(value);

		meta[match[1]] = value;
	}

	return { meta, body };
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
			lines.push(`${key}: ${value}`);
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
