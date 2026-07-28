/**
 * Tool: memory_search
 *
 * Busca na memória persistente entre sessões.
 * LLM usa quando precisa de contexto sobre padrões, decisões ou preferências
 * que não foram injetados automaticamente.
 *
 * Fase 2.4: Suporte a busca vetorial (semântica) adicional.
 * Fase 2.5: RRF fusion entre BM25 + Vector (substituirá merge simples atual).
 */

import { Type } from "typebox";
import type { Bm25Retriever } from "../retrieve/bm25";
import type { RetrievalResult, MemoryType, MemoryScope } from "../types";

export interface VectorSearchFn {
  search: (query: string, topK?: number) => Promise<RetrievalResult[]>;
}

export function createMemorySearchTool(
  retriever: Bm25Retriever,
  projectId: string,
  vectorSearch?: VectorSearchFn
) {
  return {
    name: "memory_search",
    label: "Memory: Search",
    description:
      "Search persistent memory across sessions. Use when you need " +
      "context about project patterns, past decisions, or user preferences " +
      "that wasn't automatically injected.",

    parameters: Type.Object({
      query: Type.String({
        description: "Search query — use keywords or natural language",
      }),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("preference"),
            Type.Literal("decision"),
            Type.Literal("lesson"),
            Type.Literal("fact"),
            Type.Literal("pattern"),
          ],
          { description: "Filter by memory type" }
        )
      ),
      scope: Type.Optional(
        Type.Union(
          [
            Type.Literal("project"),
            Type.Literal("user"),
            Type.Literal("session"),
            Type.Literal("global"),
          ],
          { description: "Filter by scope (default: project)", default: "project" }
        )
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { query: string; type?: MemoryType; scope?: MemoryScope },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) {
      const scope = params.scope ?? "project";
      const topK = 10;

      // 1. BM25 (lexical)
      const bm25Results = retriever.search(params.query, projectId, topK);

      // 2. Vector (semântico) — se disponível
      let vectorResults: RetrievalResult[] = [];
      if (vectorSearch) {
        try {
          vectorResults = await vectorSearch.search(params.query, topK);
        } catch {
          // Vector search falhou, continua com BM25 apenas
        }
      }

      // 3. Merge simples: BM25 primeiro, depois vector (dedup por ID)
      const seen = new Set<string>();
      const merged: RetrievalResult[] = [];

      for (const r of bm25Results) {
        if (!seen.has(r.memory.id)) {
          seen.add(r.memory.id);
          merged.push(r);
        }
      }
      for (const r of vectorResults) {
        if (!seen.has(r.memory.id)) {
          seen.add(r.memory.id);
          merged.push(r);
        }
      }

      // 4. Filtra por type e scope
      let filtered = merged;
      if (params.type) {
        filtered = filtered.filter((r) => r.memory.type === params.type);
      }
      filtered = filtered.filter((r) => r.memory.scope === scope);

      // Limita a topK final
      filtered = filtered.slice(0, topK);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No memories found." }],
          details: { results: [] },
        };
      }

      const formatted = filtered
        .map(
          (r) =>
            `- [${r.memory.type}][${r.memory.scope}][${r.strategy}][score:${r.score.toFixed(2)}] ${r.memory.text}`
        )
        .join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
        details: {
          results: filtered.map((r) => ({
            id: r.memory.id,
            type: r.memory.type,
            scope: r.memory.scope,
            text: r.memory.text,
            confidence: r.memory.confidence,
            score: r.score,
            strategy: r.strategy,
          })),
        },
      };
    },
  };
}
