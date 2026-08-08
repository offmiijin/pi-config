/**
 * pi-memory — memory_search tool.
 *
 * Busca com fallback completo: SQLite/FTS5 é a engine primária; ripgrep é o
 * fallback tanto quando o índice está indisponível (falha de abertura/sync no
 * startup) quanto quando uma query SQLite falha em runtime. Só retorna erro
 * se AMBAS falharem.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_MEMORY_SEARCH_ATTEMPTS } from "../constants.ts";
import { buildSearchPattern, searchMemories, type SearchResult } from "../memory-search.ts";
import type { IndexSearchResult } from "../memory-index.ts";
import { SearchSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

/** Formata resultados do índice (BM25) para o modelo. */
export function formatIndexResults(results: IndexSearchResult[]): string {
	const lines: string[] = [`Found ${results.length} result(s):`, ""];
	for (const r of results) {
		lines.push(`  memories/${r.path} (${r.confidence}, ${r.updated})`);
		lines.push(`    tipo: ${r.type} · contexto: ${r.context} · escopo: ${r.scope}`);
		lines.push(`    título: ${r.title}`);
		if (r.summary) lines.push(`    resumo: ${r.summary}`);
		if (r.snippet) lines.push(`    trecho: ${r.snippet}`);
		lines.push("");
	}
	return lines.join("\n");
}

/** Formata resultados do fallback ripgrep (mesmo contrato do rg antigo). */
export function formatRgResults(results: SearchResult[]): string {
	const lines: string[] = [`Found ${results.length} result(s):`, ""];
	for (const r of results) {
		const displayPath = r.file.replace(/^.*\/memories\//, "memories/");
		lines.push(`  ${displayPath}`);
		for (const l of r.lines.slice(0, 5)) {
			lines.push(`    ${l}`);
		}
		if (r.lines.length > 5) {
			lines.push(`    ... ${r.lines.length - 5} more matches`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** True quando ao menos um termo tem conteúdo — evita `rg -- ""` (casaria tudo). */
export function hasMeaningfulTerm(terms: string[]): boolean {
	return terms.some((t) => t.trim().length > 0);
}

/**
 * Engine usada pela busca — reportada em details.
 * - "sqlite"               — índice FTS5/BM25 serviu a query.
 * - "rg"                   — índice indisponível; fallback direto.
 * - "rg-after-sqlite-error" — índice aberto, mas a query SQLite falhou; fallback rg.
 */
export type SearchEngine = "sqlite" | "rg" | "rg-after-sqlite-error";

export interface SearchDispatch {
	engine: SearchEngine;
	count: number;
	text: string;
	/** Erro da engine primária (SQLite) quando houve fallback — diagnóstico. */
	primaryError?: string;
}

/**
 * Executa a busca com fallback: tenta SQLite (indexSearch); se lançar, tenta
 * ripgrep (rgSearch). Nunca lança — ambos os callbacks são responsáveis por
 * formatar seus resultados. Retorna engine real + texto formatado.
 */
export function dispatchSearch(
	indexSearch: () => IndexSearchResult[],
	rgSearch: () => SearchResult[],
): SearchDispatch {
	try {
		const results = indexSearch();
		const text = results.length > 0 ? formatIndexResults(results) : "";
		return { engine: "sqlite", count: results.length, text };
	} catch (err) {
		const primaryError = (err as Error).message ?? String(err);
		try {
			const results = rgSearch();
			const text = results.length > 0 ? formatRgResults(results) : "";
			return { engine: "rg-after-sqlite-error", count: results.length, text, primaryError };
		} catch (err2) {
			const msg = (err2 as Error).message ?? String(err2);
			throw new Error(`SQLite: ${primaryError}; rg: ${msg}`);
		}
	}
}

export function registerMemorySearch(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Searches memories via SQLite FTS5/BM25 index (ripgrep fallback). " +
			"query accepts multiple keywords (OR semantics — any term matches). " +
			"scope: 'global' (only global), 'project' (only current project), 'all' (default: current project + global). " +
			"Use when you need past context about a topic. " +
			`Max ${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results — then abandon and search the code instead. ` +
			"NATIVE pi tool — call memory_search directly, NOT via mcp({ tool: 'memory_search' }) or the mcp gateway.",
		promptSnippet:
			"memory_search: Search past memories (multi-term; max 3 empty tries)",
		promptGuidelines: [
			"Before searching the codebase or web for information about a topic, use memory_search FIRST — past learnings, decisions, patterns and gotchas may already be stored in memories.",
			"Use memory_search when you need past context about a topic, pattern, decision, or gotcha.",
			"Pass multiple keywords as an array — OR semantics (e.g. query: ['cache', 'invalidation']). Pack synonyms/alternatives in one call.",
			"Memories are stored in PT-BR — use Portuguese terms in your queries.",
			`After ${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches with no results, stop searching memories and continue searching the code instead.`,
		],
		parameters: SearchSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				if (!params.query || params.query.length === 0) {
					return {
						content: [{ type: "text", text: "Error: query must contain at least one term." }],
						details: { error: "empty_query" },
					};
				}
				// Termos só com espaços → nem SQLite nem rg rodam (rg com padrão
				// vazio casaria todos os arquivos). Conta como busca vazia.
				if (!hasMeaningfulTerm(params.query)) {
					state.consecutiveEmptySearches++;
					const remaining = MAX_MEMORY_SEARCH_ATTEMPTS - state.consecutiveEmptySearches;
					if (remaining <= 0) {
						return {
							content: [
								{
									type: "text",
									text:
										`No memories found. Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results) — ` +
										"stop searching memories and continue searching the code instead.",
								},
							],
							details: {
								count: 0,
								limit_reached: true,
								consecutive_empty: state.consecutiveEmptySearches,
							},
						};
					}
					return {
						content: [
							{
								type: "text",
								text:
									`No memories found matching your query. Attempts remaining before abandoning memory search: ${remaining}.`,
							},
						],
						details: { count: 0, consecutive_empty: state.consecutiveEmptySearches },
					};
				}
				if (state.consecutiveEmptySearches >= MAX_MEMORY_SEARCH_ATTEMPTS) {
					return {
						content: [
							{
								type: "text",
								text:
									`Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results). ` +
									"Stop searching memories and continue searching the code instead.",
							},
						],
						details: { error: "limit_reached", consecutive_empty: state.consecutiveEmptySearches },
					};
				}
				if (params.scope !== "global" && !state.projectId) {
					return {
						content: [
							{ type: "text", text: "Error: no active project for scope=project/all" },
						],
						details: { error: "no_active_project" },
					};
				}

				// Engine primária: SQLite/FTS5 quando aberto e sem rebuild pendente.
				const indexReady =
					state.index !== null && state.index.isOpen && !state.index.needsRebuild;
				let engine: SearchEngine = "rg";
				let count = 0;
				let text = "";
				if (indexReady) {
					const dispatch = dispatchSearch(
						() =>
							state.index!.search({
								terms: params.query,
								scope: params.scope ?? "all",
								type: params.type,
								minConfidence: params.min_confidence,
								limit: params.limit,
								projectId: state.projectId,
							}),
						() =>
							searchMemories({
								query: buildSearchPattern(params.query),
								scope: params.scope ?? "all",
								type: params.type,
								minConfidence: params.min_confidence,
								limit: params.limit,
								projectId: state.projectId,
							}),
					);
					engine = dispatch.engine;
					count = dispatch.count;
					text = dispatch.text;
					if (dispatch.primaryError) {
						console.warn(
							`[pi-memory] search: SQLite falhou — fallback rg: ${dispatch.primaryError}`,
						);
					}
				} else {
					// Índice indisponível → rg direto.
					const results = searchMemories({
						query: buildSearchPattern(params.query),
						scope: params.scope ?? "all",
						type: params.type,
						minConfidence: params.min_confidence,
						limit: params.limit,
						projectId: state.projectId,
					});
					count = results.length;
					text = count > 0 ? formatRgResults(results) : "";
				}

				if (count === 0) {
					state.consecutiveEmptySearches++;
					if (state.consecutiveEmptySearches >= MAX_MEMORY_SEARCH_ATTEMPTS) {
						return {
							content: [
								{
									type: "text",
									text:
										`No memories found. Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results) — ` +
										"stop searching memories and continue searching the code instead.",
								},
							],
							details: {
								count: 0,
								limit_reached: true,
								consecutive_empty: state.consecutiveEmptySearches,
							},
						};
					}
					const remaining =
						MAX_MEMORY_SEARCH_ATTEMPTS - state.consecutiveEmptySearches;
					return {
						content: [
							{
								type: "text",
								text:
									`No memories found matching your query. Attempts remaining before abandoning memory search: ${remaining}.`,
							},
						],
						details: { count: 0, consecutive_empty: state.consecutiveEmptySearches },
					};
				}

				// Found results — reset empty-search counter (can keep searching)
				state.consecutiveEmptySearches = 0;

				return {
					content: [{ type: "text", text }],
					details: { count, engine },
				};
			} catch (e: unknown) {
				const msg = (e as Error).message ?? String(e);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: { error: msg },
				};
			}
		},
	});
}
