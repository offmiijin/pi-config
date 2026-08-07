/**
 * pi-memory — Shared constants + project setup.
 *
 * Portabilidade: usa getAgentDir() do pi-coding-agent (honra $PI_AGENT_DIR
 * e rebrandings via CONFIG_DIR_NAME) em vez de hardcodar ~/.pi/agent —
 * funciona em qualquer máquina Linux sem paths fixos.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Constants ──────────────────────────────────────────────────────────────

/** Raiz das memórias — diretório do agente real (env/rebranding-aware). */
export const MEMORIES_ROOT = join(getAgentDir(), "memories");
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

/** Memory content language rule — memories are stored in PT-BR. */
export const MEMORY_LANGUAGE_RULE =
	"Write all memory content (title, content, tags) in PT-BR (Brazilian Portuguese).";

// ── Project identification ─────────────────────────────────────────────────

/**
 * Lê a URL do remote origin (git opcional).
 * Retorna null quando não é repo git ou o git está ausente.
 * Exportado para testes (mock de execSync).
 */
export function getGitRemoteUrl(cwd: string): string | null {
	try {
		return execSync("git remote get-url origin", {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 3000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Identifies the project by git remote origin.
 *
 * 1. Tries `git remote get-url origin` (git opcional — sem git, cai no fallback)
 * 2. Normalizes to `host_user_repo` format (e.g. `github.com_user_repo`)
 * 3. Falls back to `__unmanaged_<cwd_hash_12>`
 */
export function identifyProject(
	cwd: string,
	gitRemote: (c: string) => string | null = getGitRemoteUrl,
): string {
	const remote = gitRemote(cwd);
	if (remote !== null) {
		// Strip protocol, auth, .git
		const normalized = remote
			.replace(/^git@/, "")
			.replace(/^https?:\/\//, "")
			.replace(/^ssh:\/\//, "")
			.replace(/\.git$/, "")
			.replace(/\/$/, "");

		return normalized.replace(/[/:]/g, "_");
	}
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
	return `__unmanaged_${hash}`;
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
 * Ensures all required memory directories exist (private, 0o700).
 * Idempotente. Retorna TODOS os paths esperados (contrato antigo).
 *
 * Portabilidade: falha de permissão num diretório NÃO derruba a extensão —
 * avisa e segue; as tools reportam erro por chamada se a escrita falhar.
 */
export function ensureDirectories(projectId: string): string[] {
	const dirs = getMemoryDirectories(projectId);
	for (const dir of dirs) {
		if (existsSync(dir)) continue;
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// recursive só aplica mode ao último nível; força 0o700 em todos
			try {
				chmodSync(dir, 0o700);
			} catch {
				// chmod não crítico — segue
			}
		} catch (err) {
			console.warn(`[pi-memory] não pôde criar ${dir}: ${(err as Error).message}`);
		}
	}
	return dirs;
}
