/**
 * pi-memory — memory_search tool.
 *
 * Busca com fallback completo: SQLite/FTS5 é a engine primária; ripgrep é o
 * fallback tanto quando o índice está indisponível (falha de abertura/sync no
 * startup) quanto quando uma query SQLite falha em runtime. Só retorna erro
 * se AMBAS falharem.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_MEMORY_SEARCH_ATTEMPTS, MIN_MEMORY_SEARCH_TERMS } from "../constants.ts";
import { buildSearchPattern, searchMemories, type SearchResult } from "../memory/memory-search.ts";
import type { IndexSearchResult } from "../memory/memory-index.ts";
import { relFromMemoriesRoot } from "../memory/memory-index.ts";
import { SearchSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

/** Formata resultados do índice (BM25) para o modelo. */
export function formatIndexResults(results: IndexSearchResult[], query?: string[]): string {
	const lines: string[] = [`Found ${results.length} result(s):`];
	if (query) lines.push(`Search query: ${JSON.stringify(query)}`);
	lines.push("");
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
export function formatRgResults(results: SearchResult[], query?: string[]): string {
	const lines: string[] = [`Found ${results.length} result(s):`];
	if (query) lines.push(`Search query: ${JSON.stringify(query)}`);
	lines.push("");
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
	query?: string[],
): SearchDispatch {
	try {
		const results = indexSearch();
		const text = results.length > 0 ? formatIndexResults(results, query) : "";
		return { engine: "sqlite", count: results.length, text };
	} catch (err) {
		const primaryError = (err as Error).message ?? String(err);
		try {
			const results = rgSearch();
			const text = results.length > 0 ? formatRgResults(results, query) : "";
			return { engine: "rg-after-sqlite-error", count: results.length, text, primaryError };
		} catch (err2) {
			const msg = (err2 as Error).message ?? String(err2);
			throw new Error(`SQLite: ${primaryError}; rg: ${msg}`);
		}
	}
}

/**
 * Registra o uso dos resultados de uma busca no .retention.sqlite
 * (fire-and-forget). Nunca lança: falha do store degrada e segue — a busca
 * já retornou; o registro é efeito colateral. Também faz o bump imediato do
 * score no índice (a sessão atual enxerga a memória fresca sem esperar o
 * próximo sweep). Dedup por path: cada memória conta uma vez por chamada.
 */
export function recordSearchAccesses(
	state: ToolState,
	entries: { path: string; memoryId: string | null }[],
): void {
	const store = state.retention;
	if (!store || !store.isOpen || entries.length === 0) return;
	const seen = new Set<string>();
	const bumps = new Map<string, number>();
	for (const e of entries) {
		if (e.path.length === 0 || seen.has(e.path)) continue;
		seen.add(e.path);
		try {
			const res = store.recordAccess(e.memoryId, e.path);
			if (res.recorded) bumps.set(e.path, 1.0);
		} catch (err) {
			console.warn(
				`[pi-memory] retention: falha ao registrar acesso (${e.path}): ${(err as Error).message}`,
			);
		}
	}
	if (bumps.size > 0 && state.index?.isOpen) {
		try {
			state.index.updateRetentionScores(bumps);
		} catch (err) {
			console.warn(
				`[pi-memory] retention: bump do score no índice falhou: ${(err as Error).message}`,
			);
		}
	}
}

export function registerMemorySearch(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Searches memories via SQLite FTS5/BM25 index (ripgrep fallback). " +
			`query requires at least ${MIN_MEMORY_SEARCH_TERMS} specific Brazilian Portuguese keywords or short phrases — never a question or long sentence. ` +
			"Terms use OR semantics, so any one term may match; avoid generic terms and combine keywords with short phrases when useful. " +
			"scope: 'global' (only global), 'project' (only current project), 'all' (default: current project + global). " +
			"Use when you need past context about a topic. " +
			`Max ${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results — then abandon and search the code instead. ` +
			"NATIVE pi tool — call memory_search directly, NOT via mcp({ tool: 'memory_search' }) or the mcp gateway.",
		promptSnippet:
			"memory_search: Search past memories (at least 5 specific PT-BR keywords or short phrases; OR semantics; max 5 empty tries)",
		promptGuidelines: [
			"Before searching the codebase or web for information about a topic, use memory_search FIRST — past learnings, decisions, patterns and gotchas may already be stored in memories.",
			"Use memory_search when you need past context about a topic, pattern, decision, or gotcha.",
			`Build query with at least ${MIN_MEMORY_SEARCH_TERMS} specific Brazilian Portuguese keywords or short phrases — never a full question or long sentence. Mix single words and short phrases when useful.`,
			"Terms use OR semantics: one matching term is enough, so avoid generic words such as 'projeto' or 'memória' unless they are truly relevant. Pack synonyms and alternatives in the same call.",
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
				if (params.query.length < MIN_MEMORY_SEARCH_TERMS) {
					return {
						content: [
							{
								type: "text",
								text: `Error: query must contain at least ${MIN_MEMORY_SEARCH_TERMS} terms in Brazilian Portuguese.`,
							},
						],
						details: {
							error: "too_few_terms",
							required_terms: MIN_MEMORY_SEARCH_TERMS,
							provided_terms: params.query.length,
						},
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
										`No memories found for query ${JSON.stringify(params.query)}. Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results) — ` +
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
									`No memories found matching query ${JSON.stringify(params.query)}. Attempts remaining before abandoning memory search: ${remaining}.`,
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
									`Memory search limit reached for query ${JSON.stringify(params.query)} (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results). ` +
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
				// Resultados crus capturados pelos callbacks — registro de uso de
				// retenção roda sobre eles (não sobre o texto formatado).
				let indexResults: IndexSearchResult[] = [];
				let rgResults: SearchResult[] = [];
				if (indexReady) {
					const dispatch = dispatchSearch(
						() => {
							indexResults = state.index!.search({
								terms: params.query,
								scope: params.scope ?? "all",
								type: params.type,
								minConfidence: params.min_confidence,
								limit: params.limit,
								projectId: state.projectId,
							});
							return indexResults;
						},
						() => {
							rgResults = searchMemories({
								query: buildSearchPattern(params.query),
								scope: params.scope ?? "all",
								type: params.type,
								minConfidence: params.min_confidence,
								limit: params.limit,
								projectId: state.projectId,
							});
							return rgResults;
						},
						params.query,
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
					rgResults = searchMemories({
						query: buildSearchPattern(params.query),
						scope: params.scope ?? "all",
						type: params.type,
						minConfidence: params.min_confidence,
						limit: params.limit,
						projectId: state.projectId,
					});
					count = rgResults.length;
					text = count > 0 ? formatRgResults(rgResults, params.query) : "";
				}

				// Uso conta apenas com resultados reais (busca vazia não registra).
				if (count > 0) {
					if (indexResults.length > 0) {
						recordSearchAccesses(
							state,
							indexResults.map((r) => ({ path: r.path, memoryId: r.memoryId || null })),
						);
					} else if (rgResults.length > 0) {
						recordSearchAccesses(
							state,
							rgResults.map((r) => ({
								path: relFromMemoriesRoot(r.file),
								memoryId: r.memoryId,
							})),
						);
					}
				}

				if (count === 0) {
					state.consecutiveEmptySearches++;
					if (state.consecutiveEmptySearches >= MAX_MEMORY_SEARCH_ATTEMPTS) {
						return {
							content: [
								{
									type: "text",
									text:
										`No memories found for query ${JSON.stringify(params.query)}. Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results) — ` +
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
									`No memories found matching query ${JSON.stringify(params.query)}. Attempts remaining before abandoning memory search: ${remaining}.`,
							},
						],
						details: { count: 0, consecutive_empty: state.consecutiveEmptySearches },
					};
				}

				// Resultados encontrados — reseta o contador de buscas vazias (pode continuar buscando)
				state.consecutiveEmptySearches = 0;

				return {
					content: [{ type: "text", text }],
					details: { count, engine },
				};
			} catch (e: unknown) {
				const msg = (e as Error).message ?? String(e);
				return {
					content: [
						{
							type: "text",
							text: `Search failed for query ${JSON.stringify(params.query)}: ${msg}`,
						},
					],
					details: { error: msg, query: params.query },
				};
			}
		},
	});
}
