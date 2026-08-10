/**
 * pi-memory — Estado mutável compartilhado entre index.ts (event handlers) e
 * tools.
 *
 * Só os campos que as tools leem/escrevem vivem aqui. O resto do estado da
 * extensão (pipeline/worker são criados no session_start e injetados aqui
 * para as tools de Fase 6 consumirem).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMemoryStats } from "../memory/memory.ts";
import type { IndexDocument, MemoryIndex } from "../memory/memory-index.ts";
import type { PipelineDB } from "../pipeline/pipeline.ts";
import type { PipelineWorker } from "../pipeline/worker.ts";

export interface ToolState {
	projectId: string;
	currentSessionHash: string;
	/** Buscas consecutivas sem resultado (política: abandonar após MAX_MEMORY_SEARCH_ATTEMPTS). */
	consecutiveEmptySearches: number;
	/** Cache do índice de memórias no system prompt (invalidado em escritas). */
	cachedIndexText: string | null;
	/** Índice SQLite/FTS5 aberto na sessão (null se indisponível → fallback rg). */
	index: MemoryIndex | null;
	/** Pipeline operacional (Fase 6) — null se indisponível. */
	pipeline: PipelineDB | null;
	/** Worker assíncrono (Fase 6) — null se indisponível. */
	worker: PipelineWorker | null;
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

/**
 * Emite o evento custom:memory-stats com a contagem atual de memórias
 * (global + project). Consumido pelo status-bar do custom-theme — a
 * apresentação fica desacoplada do storage. No-op sem projectId ativo.
 */
export function emitMemoryStats(pi: ExtensionAPI, state: ToolState): void {
	if (!state.projectId) return;
	pi.events?.emit("custom:memory-stats", getMemoryStats(state.projectId));
}
