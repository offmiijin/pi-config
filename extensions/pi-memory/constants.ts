/**
 * pi-memory — Constantes compartilhadas + setup de projeto.
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

/** Raiz das memórias — diretório do agente real (env/rebranding-aware). */
export const MEMORIES_ROOT = join(getAgentDir(), "memories");

/**
 * Orçamentos de tokens para evidências (evidence.ts) — prompt/response/tool
 * result em chars aproximados (~4 chars/token).
 */
export const OBSERVATION_TOKEN_BUDGETS = {
	prompt: 1000,
	response: 2000,
	toolResult: 500,
} as const;

/** Approximate chars per token for size estimation (English-centric heuristic). */
export const CHARS_PER_TOKEN = 4;
/** Max consecutive memory_search calls with no results before the model abandons. */
export const MAX_MEMORY_SEARCH_ATTEMPTS = 3;

export const MEMORY_TYPES = ["_rules", "decisions", "gotchas", "lessons", "patterns"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Memory content language rule — memories are stored in PT-BR. */
export const MEMORY_LANGUAGE_RULE =
	"Write all memory content (title, content, tags) in PT-BR (Brazilian Portuguese).";

/* ------------------------------------------------------------------ */
/* Retenção por inatividade (decay automático por desuso)              */
/* ------------------------------------------------------------------ */

/** Feature flag — módulo de retenção desativado por padrão (rollout seguro). */
export const RETENTION_ENABLED = false;

/** Nome do banco de atividade (derivado, reconstruível). */
export const RETENTION_DB_FILENAME = ".retention.sqlite";
export const RETENTION_DB_PATH = join(MEMORIES_ROOT, RETENTION_DB_FILENAME);

/** Sem decay antes deste período sem uso (dias). */
export const RETENTION_GRACE_DAYS = 30;
/** Meia-vida do score: cai pela metade a cada N dias de desuso. */
export const RETENTION_HALF_LIFE_DAYS = 90;
/** Piso do score — evita memória com score ~0 invisível de vez. */
export const RETENTION_MIN_SCORE = 0.05;
/** Intervalo do sweep periódico (24h). */
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RetentionPolicy = "normal" | "protected";

/** Política default por tipo: _rules sempre protegida de decay automático. */
export function defaultRetentionPolicy(type: string): RetentionPolicy {
	return type === "_rules" ? "protected" : "normal";
}

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
 * Identifica o projeto pela URL do remote origin do git.
 *
 * 1. Tenta `git remote get-url origin` (git opcional — sem git, cai no fallback)
 * 2. Normaliza para o formato `host_user_repo` (ex.: `github.com_user_repo`)
 * 3. Cai para `__unmanaged_<cwd_hash_12>`
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

/**
 * Retorna a lista de todos os diretórios que devem existir para um projeto.
 */
export function getMemoryDirectories(projectId: string): string[] {
	const globalDirs = MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, "_global", t));
	const supersedesGlobal = MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, ".supersedes", "_global", t));
	const historyGlobal = MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, ".history", "_global", t));
	const projectDirs = [...MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, "projects", projectId, t))];
	const supersedesProject = MEMORY_TYPES.map((t) =>
		join(MEMORIES_ROOT, ".supersedes", "projects", projectId, t),
	);
	const historyProject = MEMORY_TYPES.map((t) =>
		join(MEMORIES_ROOT, ".history", "projects", projectId, t),
	);

	return [
		MEMORIES_ROOT,
		...globalDirs,
		...supersedesGlobal,
		...historyGlobal,
		...projectDirs,
		...supersedesProject,
		...historyProject,
	];
}

/**
 * Garante que todos os diretórios de memória existam (privados, 0o700).
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
