/**
 * pi-memory — Tool parameter schemas (no PI dependency beyond typebox).
 */

import { Type } from "typebox";

// ── Helper: enum from string literals ─────────────────────────────────────

/**
 * Creates a TypeBox union of literal string types.
 * Equivalent to StringEnum from @earendil-works/pi-ai.
 */
function StringEnum<T extends readonly string[]>(values: T) {
	return Type.Union(values.map((v) => Type.Literal(v)));
}

// ── Reused enums ───────────────────────────────────────────────────────────

export const MemoryTypeEnum = StringEnum(["_rules", "decisions", "gotchas", "lessons", "patterns"] as const);
export type MemoryType = (typeof MemoryTypeEnum.static)[number];

export const ScopeEnum = StringEnum(["global", "project"] as const);
export type Scope = (typeof ScopeEnum.static)[number];

export const SearchScopeEnum = StringEnum(["global", "project", "all"] as const);
export type SearchScope = (typeof SearchScopeEnum.static)[number];

// ─── memory_save ──────────────────────────────────────────────────────────

export const SaveSchema = Type.Object({
	type: MemoryTypeEnum,
	context: Type.String({ description: "Grouping key — same context = same file" }),
	title: Type.String({ description: "Descriptive title for this entry" }),
	content: Type.String({ description: "Rich markdown content" }),
	scope: ScopeEnum,
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for search" })),
	confidence: Type.Optional(
		Type.Number({
			description: "0.1-0.9 (default 0.5, minimum 0.5)",
			minimum: 0.1,
			maximum: 0.9,
		}),
	),
	supersedes: Type.Optional(
		Type.String({ description: "Context key of memory this replaces" }),
	),
});

// ─── memory_search ────────────────────────────────────────────────────────

export const SearchSchema = Type.Object({
	query: Type.String({ description: "Text or regex (ripgrep syntax)" }),
	scope: Type.Optional(SearchScopeEnum),
	type: Type.Optional(MemoryTypeEnum),
	min_confidence: Type.Optional(
		Type.Number({ description: "Minimum confidence filter (default 0.5)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
});

// ─── memory_status ────────────────────────────────────────────────────────

export const StatusSchema = Type.Object({});

// ─── memory_decay ─────────────────────────────────────────────────────────

export const DecaySchema = Type.Object({
	context: Type.String({ description: "Context key of the memory to decay" }),
	delta: Type.Number({
		description: "Confidence reduction (-0.1 to -0.9)",
	}),
	move_to_supersedes: Type.Optional(
		Type.Boolean({ description: "Move to .supersedes/ immediately" }),
	),
	reason: Type.Optional(Type.String({ description: "Why this memory is being decayed" })),
});

// ─── memory_extract ───────────────────────────────────────────────────────

export const ExtractSchema = Type.Object({
	session_file: Type.Optional(
		Type.String({ description: "Session file path (default: current session)" }),
	),
});
