/**
 * pi-memory — Shared mutable state between index.ts (event handlers) and tools.
 *
 * Only fields the tools read/write live here. The rest of the extension state
 * (extractionDueCount, saveReminderDue, turnDedupState, toolResultsBuffer…)
 * stays as local variables in index.ts.
 */

import type { IndexDocument, MemoryIndex } from "../memory-index.ts";

export interface ToolState {
	projectId: string;
	currentSessionHash: string;
	/** Monotonic — last extraction bucket that already fired a prompt (prevents re-firing). */
	lastPromptedBucket: number;
	/** Consecutive searches without results (policy: abandon after MAX_MEMORY_SEARCH_ATTEMPTS). */
	consecutiveEmptySearches: number;
	/** Memory index cache in the system prompt (invalidated on writes). */
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
