/**
 * Tool: memory_extract
 *
 * Força extração LLM de observações pendentes, independente do threshold de 50.
 * Útil quando o usuário quer gerar memórias explicitamente sem esperar
 * o batch automático ou o SweepConsolidator.
 */

import { Type } from "typebox";
import type { IStorage } from "../storage/index";
import type { LlmExtractor } from "../extract/llm-extractor";

export interface ExtractDeps {
  storage: IStorage;
  llmExtractor: LlmExtractor;
  projectId: string;
}

export function createMemoryExtractTool(getDeps: () => ExtractDeps) {
  return {
    name: "memory_extract",
    label: "Memory: Extract",
    description:
      "Force LLM extraction of pending observations into wiki pages. " +
      "Use when you want to explicitly generate memories from recent interactions " +
      "without waiting for the automatic batch threshold (50 observations).",

    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description:
            "If true, processes observations even if count is below the automatic threshold. Default: true.",
          default: true,
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of pending observations to process. Default: all pending.",
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { force?: boolean; limit?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const deps = getDeps();
      const { storage, llmExtractor, projectId } = deps;

      if (!storage) {
        return {
          content: [{ type: "text" as const, text: "Memory system not initialized yet." }],
          details: { error: "storage not initialized" },
        };
      }

      // Coleta observações pendentes
      let pending = storage.getPendingObservations(projectId);
      if (pending.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pending observations. All observations have already been extracted or the session hasn't produced enough interactions yet.",
            },
          ],
          details: { pending: 0, processed: 0, pages: 0 },
        };
      }

      // Aplica limit se especificado
      if (params.limit && params.limit > 0 && params.limit < pending.length) {
        pending = pending.slice(0, params.limit);
      }

      // Força extração
      const suggestions = await llmExtractor.extractBatch(pending);

      const pageTitles = suggestions.map((s) => `- [${s.type}] ${s.title}`).join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Extraction complete.\n` +
              `- Observations processed: ${pending.length}\n` +
              `- Pages generated: ${suggestions.length}\n` +
              (suggestions.length > 0
                ? `\n### New pages\n${pageTitles}`
                : `\nNo extractable knowledge found in these observations.`),
          },
        ],
        details: {
          processed: pending.length,
          pages: suggestions.length,
          titles: suggestions.map((s) => s.title),
          remaining: (storage.getPendingObservations(projectId)).length,
        },
      };
    },
  };
}
