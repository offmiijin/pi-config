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
export const OBSERVATION_THRESHOLD = 50;

/**
 * Fase 0: a captura de sessão migra de observações markdown (turn_end) para
 * episódios no pipeline operacional (agent_settled → pipeline.sqlite). Flag
 * temporária de transição — com `false`, o pipeline legado de observações
 * (escrita de markdown, gatilho de extração, lembrete de save) fica inativo
 * mas o código permanece; removida na Fase 6.
 */
export const ENABLE_LEGACY_OBSERVATIONS = false;

/**
 * Orçamentos de tokens para campos de observação (aprox., ~4 chars/token).
 * Equivalente a ~4000 chars de prompt, ~8000 de resposta, ~2000 por tool result.
 */
export const OBSERVATION_TOKEN_BUDGETS = {
	prompt: 1000,
	response: 2000,
	toolResult: 500,
} as const;

/** Approximate chars per token for size estimation (English-centric heuristic). */
export const CHARS_PER_TOKEN = 4;

/**
 * Orçamento de tokens de observações por chamada do memory_extract (lote
 * incremental). ~7-8 observações típicas (~4K tokens cada); o prompt total
 * fica ~40K com overhead, seguro para modelos com >= 64K de contexto.
 */
export const EXTRACT_BATCH_TOKEN_BUDGET = 30_000;

/** Max consecutive memory_search calls with no results before the model abandons. */
export const MAX_MEMORY_SEARCH_ATTEMPTS = 3;

export const MEMORY_TYPES = ["_rules", "decisions", "gotchas", "lessons", "patterns"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Memory content language rule — memories are stored in PT-BR. */
export const MEMORY_LANGUAGE_RULE =
	"Write all memory content (title, content, tags) in PT-BR (Brazilian Portuguese).";

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
