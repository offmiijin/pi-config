/**
 * pi-memory — Schemas de parâmetros das tools (sem dependência do PI além de typebox).
 */

import { Type } from "typebox";

/**
 * Cria uma união TypeBox de tipos literal string.
 * Equivalente ao StringEnum de @earendil-works/pi-ai.
 */
function StringEnum<T extends readonly string[]>(values: T) {
	return Type.Union(values.map((v) => Type.Literal(v)));
}

export const MemoryTypeEnum = StringEnum(["_rules", "decisions", "gotchas", "lessons", "patterns"] as const);
/** Tipos derivados manualmente — TypeBox não expõe `.static` em runtime. */
export type MemoryType = "_rules" | "decisions" | "gotchas" | "lessons" | "patterns";

export const ScopeEnum = StringEnum(["global", "project"] as const);
export type Scope = "global" | "project";

export const SearchScopeEnum = StringEnum(["global", "project", "all"] as const);
export type SearchScope = "global" | "project" | "all";

export const SaveModeEnum = StringEnum(["append", "consolidate"] as const);
export type SaveMode = "append" | "consolidate";

export const SaveSchema = Type.Object({
	type: MemoryTypeEnum,
	context: Type.String({ description: "Grouping key — same context = same file" }),
	title: Type.String({ description: "Descriptive title for this entry (PT-BR)" }),
	content: Type.String({ description: "Rich markdown content (PT-BR)" }),
	scope: ScopeEnum,
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for search (PT-BR)" })),
	confidence: Type.Optional(
		Type.Number({
			description: "0.5-0.9 (default 0.5)",
			minimum: 0.5,
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
					"Fase 5: 'append' (legado) e 'consolidate' são equivalentes — toda " +
					"escrita reescreve o snapshot atual; a versão anterior vai para .history/. " +
					"Para substituir memória de OUTRA chave, use supersedes.",
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

// memory_extract não recebe parâmetros: a sessão atual é resolvida pelo
// próprio pipeline (sessionManager.getSessionFile no agent_settled) — o
// antigo parâmetro session_file era aceito e ignorado.
export const ExtractSchema = Type.Object({});

/* ------------------------------------------------------------------ */
/* Extração (Fase 3) — schema da resposta do modelo                    */
/* ------------------------------------------------------------------ */

export const ExtractionCandidateSchema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("update"),
		Type.Literal("supersede"),
		Type.Literal("ignore"),
	]),
	context: Type.String({ minLength: 1 }),
	type: Type.Optional(
		Type.Union([
			Type.Literal("_rules"),
			Type.Literal("decisions"),
			Type.Literal("gotchas"),
			Type.Literal("lessons"),
			Type.Literal("patterns"),
		]),
	),
	scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
	title: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	evidence_ids: Type.Optional(Type.Array(Type.String())),
	supersedes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	reason: Type.Optional(Type.String()),
});

export const ExtractionResponseSchema = Type.Object({
	memories: Type.Array(ExtractionCandidateSchema),
});

export type ExtractionCandidate = {
	action: "create" | "update" | "supersede" | "ignore";
	context: string;
	type?: "_rules" | "decisions" | "gotchas" | "lessons" | "patterns";
	scope?: "global" | "project";
	title?: string;
	summary?: string;
	content?: string;
	confidence?: number;
	evidence_ids?: string[];
	supersedes?: string | null;
	reason?: string;
};

export type ExtractionResponse = { memories: ExtractionCandidate[] };
