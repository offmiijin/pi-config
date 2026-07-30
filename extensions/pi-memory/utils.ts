/**
 * pi-memory — Internal helpers (pure functions, no PI dependency).
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
