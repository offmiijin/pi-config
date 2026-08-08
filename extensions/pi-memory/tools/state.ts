/**
 * pi-memory — Shared mutable state between index.ts (event handlers) and tools.
 *
 * Only fields the tools read/write live here. The rest of the extension state
 * (extractionDueCount, saveReminderDue, turnDedupState, toolResultsBuffer…)
 * stays as local variables in index.ts.
 */

import type { MemoryIndex } from "../memory-index.ts";

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
