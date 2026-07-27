/**
 * Tool: memory_write
 *
 * Escreve um fato, preferência, decisão ou lição na memória persistente.
 * LLM usa para salvar informações que devem persistir entre sessões.
 */

import { Type } from "typebox";
import type { IStorage } from "../storage/index";
import type { MemoryType, MemoryScope } from "../types";
import { contentHash, compositeKey } from "../consolidate/dedup";
import { randomUUID } from "node:crypto";

export function createMemoryWriteTool(
  storage: IStorage,
  projectId: string,
  getSessionId: () => string
) {
  return {
    name: "memory_write",
    label: "Memory: Write",
    description:
      "Write a fact, preference, decision, pattern, or lesson to persistent memory. " +
      "Use this to save information that should be remembered across sessions.",

    parameters: Type.Object({
      text: Type.String({
        description: "The memory text — a single, self-contained statement",
      }),
      type: Type.Union(
        [
          Type.Literal("preference"),
          Type.Literal("decision"),
          Type.Literal("lesson"),
          Type.Literal("fact"),
          Type.Literal("pattern"),
        ],
        { description: "Type of memory" }
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tags for categorization (e.g., [\"#docker\", \"#deploy\"])",
        })
      ),
      scope: Type.Optional(
        Type.Union(
          [
            Type.Literal("project"),
            Type.Literal("user"),
            Type.Literal("global"),
          ],
          { description: "Memory scope (default: project)", default: "project" }
        )
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        text: string;
        type: MemoryType;
        tags?: string[];
        scope?: MemoryScope;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) {
      const now = Date.now();
      const scope = params.scope ?? "project";
      const tags = params.tags ?? [];
      const hash = contentHash(params.text);
      const key = compositeKey(params.type, scope, tags);

      // Verifica dedup por hash
      const existingByHash = storage.getMemoryByHash(projectId, hash);

      if (existingByHash && !existingByHash.superseded_by) {
        // Reforça existente
        const updated = {
          ...existingByHash,
          access_count: existingByHash.access_count + 1,
          last_accessed: now,
          confidence: Math.min(existingByHash.confidence + 0.05, 1.0),
        };
        storage.updateMemory(updated);

        return {
          content: [
            {
              type: "text" as const,
              text: `Memory reinforced (already exists). Confidence: ${updated.confidence.toFixed(2)}`,
            },
          ],
          details: { action: "reinforce", id: updated.id },
        };
      }

      // Verifica last-fact-wins por chave composta
      const existingByKey = storage.getMemoriesByProject(projectId).find(
        (m) => !m.superseded_by && compositeKey(m.type, m.scope, m.tags) === key
      );

      const id = randomUUID();
      const memory = {
        id,
        text: params.text,
        embedding: null as Float32Array | null,
        type: params.type,
        scope,
        tags,
        confidence: 0.5,
        timestamp: now,
        last_accessed: now,
        access_count: 1,
        source_ids: [getSessionId()],
        superseded_by: null as string | null,
        pinned: false,
        project_id: projectId,
        content_hash: hash,
      };

      if (existingByKey) {
        // Contradição ou atualização
        const contradictionPatterns = [
          /\bnão\s+(?:usa|utiliza|usar|utilizar)\s+mais\b/i,
          /\b(?:mudou|alterou|trocou|migrou)\s+(?:de\s+)?\w+\s+para\b/i,
          /\bagora\s+(?:prefere|usa|utiliza|recomenda)\b/i,
          /\b(?:substitu[ií]do|substitui)\s+por\b/i,
          /\b(?:descontinuado|deprecated|obsoleto)\b/i,
        ];

        const hasContradiction = contradictionPatterns.some((p) =>
          p.test(params.text)
        );

        if (hasContradiction) {
          // Supersede: marca antiga como superada, cria nova
          storage.updateMemory({
            ...existingByKey,
            superseded_by: id,
          });
          storage.insertMemory(memory);

          return {
            content: [
              {
                type: "text" as const,
                text: `Memory saved (superseded previous: "${existingByKey.text.slice(0, 80)}"). ID: ${id}`,
              },
            ],
            details: { action: "supersede", id, superseded_id: existingByKey.id },
          };
        }

        // Atualiza existente
        const updated = {
          ...existingByKey,
          text: params.text,
          confidence: Math.min(existingByKey.confidence + 0.05, 1.0),
          last_accessed: now,
          access_count: existingByKey.access_count + 1,
          content_hash: hash,
        };
        storage.updateMemory(updated);

        return {
          content: [
            {
              type: "text" as const,
              text: `Memory updated. Confidence: ${updated.confidence.toFixed(2)}`,
            },
          ],
          details: { action: "update", id: existingByKey.id },
        };
      }

      // Nova memória
      storage.insertMemory(memory);

      return {
        content: [
          {
            type: "text" as const,
            text: `Memory saved. ID: ${id}`,
          },
        ],
        details: { action: "create", id },
      };
    },
  };
}
