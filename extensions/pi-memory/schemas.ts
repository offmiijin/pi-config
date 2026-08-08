/**
 * pi-memory — Tool parameter schemas (no PI dependency beyond typebox).
 */

import { Type } from "typebox";

/**
 * Creates a TypeBox union of literal string types.
 * Equivalent to StringEnum from @earendil-works/pi-ai.
 */
function StringEnum<T extends readonly string[]>(values: T) {
	return Type.Union(values.map((v) => Type.Literal(v)));
}

export const MemoryTypeEnum = StringEnum(["_rules", "decisions", "gotchas", "lessons", "patterns"] as const);
export type MemoryType = (typeof MemoryTypeEnum.static)[number];

export const ScopeEnum = StringEnum(["global", "project"] as const);
export type Scope = (typeof ScopeEnum.static)[number];

export const SearchScopeEnum = StringEnum(["global", "project", "all"] as const);
export type SearchScope = (typeof SearchScopeEnum.static)[number];

export const SaveModeEnum = StringEnum(["append", "consolidate"] as const);
export type SaveMode = (typeof SaveModeEnum.static)[number];

export const SaveSchema = Type.Object({
	type: MemoryTypeEnum,
	context: Type.String({ description: "Grouping key — same context = same file" }),
	title: Type.String({ description: "Descriptive title for this entry (PT-BR)" }),
	content: Type.String({ description: "Rich markdown content (PT-BR)" }),
	scope: ScopeEnum,
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for search (PT-BR)" })),
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
	summary: Type.Optional(
		Type.String({
			description:
				"Resumo de 1-2 frases em PT-BR do estado ATUAL da memória. " +
				"Sobrescreve o anterior no append/consolidate; usado pelo memory_extract para dedup.",
		}),
	),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("append"), Type.Literal("consolidate")],
			{
				description:
					"append (default): adiciona entrada datada ao arquivo. " +
					"consolidate: reescreve a memória — arquiva a versão atual do MESMO context em .supersedes/ e cria arquivo novo " +
					"(use quando a informação nova atualiza/contradiz a existente; para substituir memória de OUTRO context use supersedes).",
			},
		),
	),
});

export const SearchSchema = Type.Object({
	query: Type.Array(
		Type.String({ description: "Keyword to search for (OR semantics — any term matches)" }),
		{
			description:
				"One or more keywords. Pack synonyms/alternatives in one call (e.g. ['cache', 'invalidation']).",
		},
	),
	scope: Type.Optional(SearchScopeEnum),
	type: Type.Optional(MemoryTypeEnum),
	min_confidence: Type.Optional(
		Type.Number({ description: "Minimum confidence filter (default 0.5)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
});

export const StatusSchema = Type.Object({});

export const DecaySchema = Type.Object({
	context: Type.String({ description: "Context key of the memory to decay" }),
	delta: Type.Number({
		description: "Confidence reduction (-0.1 to -0.9)",
	}),
	move_to_supersedes: Type.Optional(
		Type.Boolean({ description: "Move to .supersedes/ immediately" }),
	),
	reason: Type.Optional(
		Type.String({ description: "Why this memory is being decayed (PT-BR)" }),
	),
});

export const ExtractSchema = Type.Object({
	session_file: Type.Optional(
		Type.String({ description: "Session file path (default: current session)" }),
	),
});
