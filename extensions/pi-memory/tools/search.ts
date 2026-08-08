/**
 * pi-memory — memory_search tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_MEMORY_SEARCH_ATTEMPTS } from "../constants.ts";
import { buildSearchPattern, searchMemories } from "../memory-search.ts";
import type { IndexSearchResult } from "../memory-index.ts";
import { SearchSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

/** Formata resultados do índice (BM25) para o modelo. */
function formatIndexResults(results: IndexSearchResult[]): string {
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

export function registerMemorySearch(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Searches memories via ripgrep. query accepts multiple keywords (OR semantics — any term matches). " +
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

				// Índice SQLite/FTS5 (primário); ripgrep como fallback quando o
				// índice não está disponível (falha de abertura/sync no startup).
				const indexReady =
					state.index !== null && state.index.isOpen && !state.index.needsRebuild;
				let count = 0;
				let text = "";
				if (indexReady) {
					const results = state.index!.search({
						terms: params.query,
						scope: params.scope ?? "all",
						type: params.type,
						minConfidence: params.min_confidence,
						limit: params.limit,
						projectId: state.projectId,
					});
					count = results.length;
					if (count > 0) text = formatIndexResults(results);
				} else {
					const results = searchMemories({
						query: buildSearchPattern(params.query),
						scope: params.scope ?? "all",
						type: params.type,
						minConfidence: params.min_confidence,
						limit: params.limit,
						projectId: state.projectId,
					});
					count = results.length;
					if (count > 0) {
						const lines: string[] = [`Found ${count} result(s):`, ""];
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
						text = lines.join("\n");
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
					details: { count, engine: indexReady ? "sqlite" : "rg" },
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
