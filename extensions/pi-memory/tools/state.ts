/**
 * pi-memory — Shared mutable state between index.ts (event handlers) and tools.
 *
 * Only fields the tools read/write live here. The rest of the extension state
 * (extractionDueCount, saveReminderDue, turnDedupState, toolResultsBuffer…)
 * stays as local variables in index.ts.
 */

export interface ToolState {
	projectId: string;
	currentSessionHash: string;
	/** Monotônico — último bucket de extração que já disparou prompt (evita re-disparo). */
	lastPromptedBucket: number;
	/** Buscas consecutivas sem resultado (policy: abandonar após MAX_MEMORY_SEARCH_ATTEMPTS). */
	consecutiveEmptySearches: number;
	/** Cache do índice de memórias no system prompt (invalidado em escritas). */
	cachedIndexText: string | null;
}
