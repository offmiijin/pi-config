export type MemoryScope = "global" | "project";
export type MemoryScopeFilter = "all" | MemoryScope;
export type MemoryTypeFilter =
	| "all"
	| "_rules"
	| "decisions"
	| "gotchas"
	| "lessons"
	| "patterns";

export interface MemoryEntry {
	scope: MemoryScope;
	type: string;
	context: string;
	title: string;
	summary?: string;
	excerpt: string;
	confidence: number;
	updated: string;
	/** Caminho relativo à raiz `memories/` (ex: `_global/decisions/cache.md`). */
	path: string;
}

export interface MemoryQuery {
	scope: MemoryScopeFilter;
	type: MemoryTypeFilter;
	search: string;
}

export interface MemorySnapshot {
	generatedAt: number;
	projectId: string;
	availableProjects: string[];
	query: MemoryQuery;
	entries: MemoryEntry[];
	totals: { global: number; project: number };
}
