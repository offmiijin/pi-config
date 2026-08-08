/**
 * pi-memory — Estado mutável compartilhado entre index.ts (event handlers) e
 * tools.
 *
 * Só os campos que as tools leem/escrevem vivem aqui. O resto do estado da
 * extensão (extractionDueCount, saveReminderDue, turnDedupState,
 * toolResultsBuffer…) fica como variáveis locais do index.ts.
 */

import type { IndexDocument, MemoryIndex } from "../memory-index.ts";

export interface ToolState {
	projectId: string;
	currentSessionHash: string;
	/** Monotônico — último bucket de extração que já disparou um aviso (evita re-disparo). */
	lastPromptedBucket: number;
	/** Buscas consecutivas sem resultado (política: abandonar após MAX_MEMORY_SEARCH_ATTEMPTS). */
	consecutiveEmptySearches: number;
	/** Cache do índice de memórias no system prompt (invalidado em escritas). */
	cachedIndexText: string | null;
	/** Índice SQLite/FTS5 aberto na sessão (null se indisponível → fallback rg). */
	index: MemoryIndex | null;
}

/**
 * Estado do índice reportado nos details das tools de escrita.
 * - "off"      — índice indisponível (não aberto); busca segue via rg.
 * - "synced"   — mutação aplicada ao índice com sucesso.
 * - "degraded" — falha ao sincronizar; markdown (canônico) NÃO foi revertido,
 *                o índice marca needsRebuild e o próximo syncIncremental reconcilia.
 */
export type IndexStatus = "off" | "synced" | "degraded";

/**
 * Aplica uma mutação de escrita ao índice de forma tolerante a falha.
 * Nunca lança. Usado por memory_save, memory_decay e memory_extract — a
 * semântica é unificada: falha de índice degrada e segue, nunca derruba a
 * operação canônica (markdown).
 */
export function syncIndex(
	state: ToolState,
	opts: { upsert: IndexDocument[]; remove: string[] },
): IndexStatus {
	if (!state.index?.isOpen) return "off";
	try {
		const sync = state.index.syncMutationSafe(opts);
		if (!sync.ok) {
			console.warn(`[pi-memory] índice não sincronizado: ${sync.error}`);
			return "degraded";
		}
		return "synced";
	} catch (err) {
		console.warn(`[pi-memory] índice não sincronizado: ${(err as Error).message}`);
		return "degraded";
	}
}
