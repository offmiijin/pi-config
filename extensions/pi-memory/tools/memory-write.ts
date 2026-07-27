/**
 * Tool: memory_write
 *
 * Escreve um fato, preferência, decisão ou lição na memória persistente.
 * LLM usa para salvar informações que devem persistir entre sessões.
 */

import { Type } from "typebox";
import type { IStorage } from "../storage/index";
import type { MemoryType, MemoryScope } from "../types";
import { contentHash, compositeKey, consolidateN1 } from "../consolidate/dedup";
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

      const memory = {
        id: randomUUID(),
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

      // Pipeline N1: dedup por hash → last-fact-wins por chave composta
      const result = consolidateN1({
        memory,
        getByHash: (pid, h) => storage.getMemoryByHash(pid, h),
        getByKey: (key) => {
          return (
            storage
              .getMemoriesByProject(projectId)
              .find(
                (m) =>
                  !m.superseded_by &&
                  compositeKey(m.type, m.scope, m.tags) === key
              ) ?? null
          );
        },
      });

      switch (result.action) {
        case "create": {
          storage.insertMemory(result.memory);
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory saved. ID: ${result.memory.id}`,
              },
            ],
            details: { action: "create", id: result.memory.id },
          };
        }

        case "reinforce": {
          storage.updateMemory(result.memory);
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory reinforced (already exists). Confidence: ${result.memory.confidence.toFixed(2)}`,
              },
            ],
            details: { action: "reinforce", id: result.memory.id },
          };
        }

        case "update": {
          storage.updateMemory(result.memory);
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory updated. Confidence: ${result.memory.confidence.toFixed(2)}`,
              },
            ],
            details: { action: "update", id: result.memory.id },
          };
        }

        case "supersede": {
          if (result.supersededId) {
            const oldMem = storage
              .getMemoriesByProject(projectId)
              .find((m) => m.id === result.supersededId);
            if (oldMem) {
              storage.updateMemory({
                ...oldMem,
                superseded_by: result.memory.id,
              });
            }
          }
          storage.insertMemory(result.memory);
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory saved (superseded previous). ID: ${result.memory.id}`,
              },
            ],
            details: {
              action: "supersede",
              id: result.memory.id,
              superseded_id: result.supersededId,
            },
          };
        }
      }
    },
  };
}
