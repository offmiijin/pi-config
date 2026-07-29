/**
 * Tool: memory_search
 *
 * Busca na memória persistente (páginas wiki) entre sessões.
 * LLM usa quando precisa de contexto sobre decisões, preferências,
 * lições que não foram injetadas automaticamente.
 *
 * Agora busca em pages (FTS5) em vez de memories (fatos atômicos).
 */

import { Type } from "typebox";
import type { PageStore } from "../storage/page-store";
import type { PageType, PageScope } from "../types";

export function createMemorySearchTool(
  pageStore: PageStore,
  projectId: string,
) {
  return {
    name: "memory_search",
    label: "Memory: Search",
    description:
      "Search persistent memory (wiki pages) across sessions. " +
      "Use when you need context about project patterns, past decisions, " +
      "or user preferences that wasn't automatically injected.",

    parameters: Type.Object({
      query: Type.String({
        description: "Search query — use keywords or natural language",
      }),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("decision"),
            Type.Literal("preference"),
            Type.Literal("lesson"),
            Type.Literal("pattern"),
            Type.Literal("fact"),
          ],
          { description: "Filter by page type" }
        )
      ),
      scope: Type.Optional(
        Type.Union(
          [Type.Literal("project"), Type.Literal("global")],
          { description: "Filter by scope (default: project)", default: "project" }
        )
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { query: string; type?: PageType; scope?: PageScope },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const topK = 10;

      // Busca páginas via PageStore (FTS5)
      let results;
      try {
        results = pageStore.searchPages(params.query, null, topK);
      } catch {
        return {
          content: [{ type: "text" as const, text: "Memory search failed. System may not be initialized." }],
          details: { results: [] },
        };
      }

      // Filtra por type e scope
      let filtered = results;
      if (params.type) {
        filtered = filtered.filter((r) => r.page.type === params.type);
      }
      if (params.scope) {
        filtered = filtered.filter((r) => r.page.scope === params.scope);
      }

      // Limita a topK final
      filtered = filtered.slice(0, topK);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No pages found." }],
          details: { results: [] },
        };
      }

      const formatted = filtered
        .map(
          (r) =>
            `- [${r.page.type}][${r.page.scope}][score:${r.score.toFixed(2)}] **${r.page.title}** \`${r.page.path}\`\n  ${r.snippet.slice(0, 200)}`,
        )
        .join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
        details: {
          results: filtered.map((r) => ({
            path: r.page.path,
            title: r.page.title,
            type: r.page.type,
            scope: r.page.scope,
            snippet: r.snippet,
            score: r.score,
          })),
        },
      };
    },
  };
}
