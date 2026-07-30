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
