/**
 * Tool: memory_status
 *
 * Retorna estatísticas e estado do sistema de memória.
 * LLM usa para verificar o estado do sistema de memória.
 */

import { Type } from "typebox";
import type { IStorage } from "../storage/index";
import type { MemoryType, MemoryScope } from "../types";

export function createMemoryStatusTool(storage: IStorage, projectId: string) {
  return {
    name: "memory_status",
    label: "Memory: Status",
    description:
      "Show memory system statistics: total memories, observations, index status, and breakdown by type/scope.",

    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) {
      const totalMemories = storage.countMemories();
      const totalObservations = storage.countObservations();
      const pendingExtraction = storage.countPendingExtraction();

      // Busca todas as memórias para breakdown
      const memories = storage.getMemoriesByProject(projectId);

      // Contagem por tipo
      const byType: Record<MemoryType, number> = {
        preference: 0,
        decision: 0,
        lesson: 0,
        fact: 0,
        pattern: 0,
      };
      for (const m of memories) {
        byType[m.type]++;
      }

      // Contagem por scope
      const byScope: Record<MemoryScope, number> = {
        project: 0,
        user: 0,
        session: 0,
        global: 0,
      };
      for (const m of memories) {
        byScope[m.scope]++;
      }

      // Confidence média
      const avgConfidence =
        memories.length > 0
          ? memories.reduce((sum, m) => sum + m.confidence, 0) / memories.length
          : 0;

      // Pinned
      const pinnedCount = memories.filter((m) => m.pinned).length;

      // Superseded
      const supersededCount = memories.filter((m) => m.superseded_by).length;
      const activeCount = totalMemories - supersededCount;

      const lines = [
        "🧠 pi-memory",
        `   Project: ${projectId}`,
        "",
        `   Memories: ${totalMemories} total (${activeCount} active, ${supersededCount} superseded)`,
        `     By type:    preference: ${byType.preference} | decision: ${byType.decision} | lesson: ${byType.lesson} | fact: ${byType.fact} | pattern: ${byType.pattern}`,
        `     By scope:   project: ${byScope.project} | user: ${byScope.user} | session: ${byScope.session} | global: ${byScope.global}`,
        `     Avg confidence: ${avgConfidence.toFixed(2)}`,
        `     Pinned: ${pinnedCount}`,
        "",
        `   Observations: ${totalObservations} total`,
        `     Pending extraction: ${pendingExtraction}`,
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          total_memories: totalMemories,
          active_memories: activeCount,
          superseded_memories: supersededCount,
          total_observations: totalObservations,
          pending_extraction: pendingExtraction,
          by_type: byType,
          by_scope: byScope,
          avg_confidence: Math.round(avgConfidence * 100) / 100,
          pinned_count: pinnedCount,
        },
      };
    },
  };
}
