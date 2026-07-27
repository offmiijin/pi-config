/**
 * Testes da tool memory_status.
 */

import { describe, it, expect, vi } from "vitest";
import { createMemoryStatusTool } from "../../tools/memory-status";
import type { IStorage } from "../../storage/index";
import type { Memory } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMem(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: randomUUID(),
    text: "test",
    embedding: null,
    type: "fact",
    scope: "project",
    tags: [],
    confidence: 0.8,
    timestamp: now,
    last_accessed: now,
    access_count: 1,
    source_ids: [],
    superseded_by: null,
    pinned: false,
    project_id: "test-project",
    content_hash: "abc",
    ...overrides,
  };
}

function createMockStorage(memories: Memory[] = [], overrides: Partial<IStorage> = {}): IStorage {
  return {
    open: vi.fn(),
    close: vi.fn(),
    insertMemory: vi.fn(),
    getMemory: vi.fn(),
    getMemoriesByProject: vi.fn(() => [...memories]),
    getMemoryByHash: vi.fn(() => null),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn(),
    getObservations: vi.fn(() => []),
    getPendingObservations: vi.fn(() => []),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(() => 0),
    searchFts: vi.fn(() => []),
    countMemories: vi.fn(() => memories.length),
    countObservations: vi.fn(() => 42),
    countPendingExtraction: vi.fn(() => 5),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(() => []),
    ...overrides,
  };
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("memory_status tool", () => {
  it("deve retornar estatísticas com zero memórias", async () => {
    const storage = createMockStorage([]);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute(
      "id",
      {},
      undefined,
      undefined,
      undefined
    );

    expect(result.content[0].text).toContain("Memories: 0 total");
    expect(result.details.total_memories).toBe(0);
  });

  it("deve contar memórias por tipo", async () => {
    const memories = [
      makeMem({ type: "preference", text: "p1" }),
      makeMem({ type: "preference", text: "p2" }),
      makeMem({ type: "decision", text: "d1" }),
      makeMem({ type: "fact", text: "f1" }),
    ];
    const storage = createMockStorage(memories);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.details.by_type.preference).toBe(2);
    expect(result.details.by_type.decision).toBe(1);
    expect(result.details.by_type.fact).toBe(1);
    expect(result.details.by_type.lesson).toBe(0);
    expect(result.details.by_type.pattern).toBe(0);
  });

  it("deve contar memórias por scope", async () => {
    const memories = [
      makeMem({ scope: "project", text: "p" }),
      makeMem({ scope: "user", text: "u" }),
      makeMem({ scope: "global", text: "g" }),
    ];
    const storage = createMockStorage(memories);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.details.by_scope.project).toBe(1);
    expect(result.details.by_scope.user).toBe(1);
    expect(result.details.by_scope.global).toBe(1);
  });

  it("deve calcular confidence média", async () => {
    const memories = [
      makeMem({ confidence: 0.5 }),
      makeMem({ confidence: 0.9 }),
    ];
    const storage = createMockStorage(memories);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.details.avg_confidence).toBe(0.7);
  });

  it("deve contar pinned", async () => {
    const memories = [
      makeMem({ pinned: true, text: "pinned" }),
      makeMem({ pinned: false, text: "not" }),
      makeMem({ pinned: true, text: "also" }),
    ];
    const storage = createMockStorage(memories);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.details.pinned_count).toBe(2);
  });

  it("deve contar superseded separadamente", async () => {
    const memories = [
      makeMem({ text: "active 1" }),
      makeMem({ text: "active 2" }),
      makeMem({ text: "old", superseded_by: "new-id" }),
    ];
    const storage = createMockStorage(memories);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.details.total_memories).toBe(3);
    expect(result.details.active_memories).toBe(2);
    expect(result.details.superseded_memories).toBe(1);
    const text = result.content[0].text;
    expect(text).toContain("2 active");
    expect(text).toContain("1 superseded");
  });

  it("deve reportar observations e pending extraction", async () => {
    const storage = createMockStorage([], {
      countObservations: vi.fn(() => 150),
      countPendingExtraction: vi.fn(() => 23),
    });
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.content[0].text).toContain("Observations: 150 total");
    expect(result.content[0].text).toContain("Pending extraction: 23");
    expect(result.details.total_observations).toBe(150);
    expect(result.details.pending_extraction).toBe(23);
  });

  it("deve reportar projectId", async () => {
    const storage = createMockStorage([]);
    const tool = createMemoryStatusTool(storage, "my-cool-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.content[0].text).toContain("my-cool-project");
  });

  it("deve ter confidence=0 quando não há memórias", async () => {
    const storage = createMockStorage([]);
    const tool = createMemoryStatusTool(storage, "test-project");

    const result = await tool.execute("id", {}, undefined, undefined, undefined);

    expect(result.details.avg_confidence).toBe(0);
  });
});
