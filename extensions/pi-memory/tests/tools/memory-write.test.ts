/**
 * Testes da tool memory_write.
 */

import { describe, it, expect, vi } from "vitest";
import { createMemoryWriteTool } from "../../tools/memory-write";
import type { IStorage } from "../../storage/index";
import type { Memory, RawObservation } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function createMockStorage(memories: Memory[] = []): IStorage {
  return {
    open: vi.fn(),
    close: vi.fn(),
    insertMemory: vi.fn(),
    getMemory: vi.fn((id: string) => memories.find((m) => m.id === id) ?? null),
    getMemoriesByProject: vi.fn((_projectId: string) => [...memories]),
    getMemoryByHash: vi.fn((_projectId: string, hash: string) =>
      memories.find((m) => m.content_hash === hash && !m.superseded_by) ?? null
    ),
    updateMemory: vi.fn((mem: Memory) => {
      const idx = memories.findIndex((m) => m.id === mem.id);
      if (idx >= 0) memories[idx] = mem;
    }),
    deleteMemory: vi.fn(),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn(),
    getObservations: vi.fn(() => []),
    getPendingObservations: vi.fn(() => []),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(() => 0),
    searchFts: vi.fn(() => []),
    countMemories: vi.fn(() => memories.length),
    countObservations: vi.fn(() => 0),
    countPendingExtraction: vi.fn(() => 0),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(() => []),
  };
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("memory_write tool", () => {
  it("deve criar nova memória", async () => {
    const storage = createMockStorage();
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-1");

    const result = await tool.execute(
      "id",
      {
        text: "Payment API usa hexagonal architecture",
        type: "decision",
        tags: ["#architecture"],
        scope: "project",
      },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.action).toBe("create");
    expect(result.details.id).toBeDefined();
    expect(storage.insertMemory).toHaveBeenCalled();
  });

  it("deve reforçar memória existente com mesmo hash", async () => {
    const existing: Memory = {
      id: "existing-1",
      text: "Usa pnpm",
      type: "preference",
      scope: "project",
      tags: [],
      confidence: 0.5,
      timestamp: Date.now(),
      last_accessed: Date.now(),
      access_count: 1,
      source_ids: [],
      superseded_by: null,
      pinned: false,
      project_id: "test-project",
      content_hash: "",
      embedding: null,
    };
    existing.content_hash = require("node:crypto")
      .createHash("sha256")
      .update(
        "Usa pnpm"
          .toLowerCase()
          .trim()
      )
      .digest("hex");

    const storage = createMockStorage([existing]);
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-1");

    const result = await tool.execute(
      "id",
      { text: "Usa pnpm", type: "preference" },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.action).toBe("reinforce");
    expect(result.content[0].text).toContain("reinforced");
  });

  it("deve fazer supersede quando há contradição", async () => {
    const existing: Memory = {
      id: "existing-old",
      text: "usa npm",
      type: "preference",
      scope: "project",
      tags: [],
      confidence: 0.5,
      timestamp: Date.now(),
      last_accessed: Date.now(),
      access_count: 1,
      source_ids: [],
      superseded_by: null,
      pinned: false,
      project_id: "test-project",
      content_hash: "abc",
      embedding: null,
    };

    const storage = createMockStorage([existing]);
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-1");

    const result = await tool.execute(
      "id",
      {
        text: "agora prefere pnpm em vez de npm",
        type: "preference",
      },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.action).toBe("supersede");
    expect(result.details.superseded_id).toBe("existing-old");
  });

  it("deve atualizar existente quando sem contradição", async () => {
    const existing: Memory = {
      id: "existing",
      text: "usa pnpm",
      type: "preference",
      scope: "project",
      tags: [],
      confidence: 0.5,
      timestamp: Date.now(),
      last_accessed: Date.now(),
      access_count: 2,
      source_ids: [],
      superseded_by: null,
      pinned: false,
      project_id: "test-project",
      content_hash: "old-hash",
      embedding: null,
    };

    const storage = createMockStorage([existing]);
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-1");

    const result = await tool.execute(
      "id",
      {
        text: "usa pnpm em todos os projetos",
        type: "preference",
      },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.action).toBe("update");
    expect(result.details.id).toBe("existing");
  });

  it("deve usar scope=project como default", async () => {
    const storage = createMockStorage();
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-1");

    await tool.execute(
      "id",
      { text: "Test", type: "fact" },
      undefined,
      undefined,
      undefined
    );

    const insertCall = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertCall.scope).toBe("project");
  });

  it("deve gerar content_hash automaticamente", async () => {
    const storage = createMockStorage();
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-1");

    await tool.execute(
      "id",
      { text: "Test", type: "fact" },
      undefined,
      undefined,
      undefined
    );

    const insertCall = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertCall.content_hash).toBeDefined();
    expect(insertCall.content_hash).toHaveLength(64);
  });

  it("deve armazenar session_id nos source_ids", async () => {
    const storage = createMockStorage();
    const tool = createMemoryWriteTool(storage, "test-project", () => "session-xyz");

    await tool.execute(
      "id",
      { text: "Test", type: "fact" },
      undefined,
      undefined,
      undefined
    );

    const insertCall = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertCall.source_ids).toContain("session-xyz");
  });
});
