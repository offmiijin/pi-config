/**
 * Testes da tool memory_search.
 */

import { describe, it, expect, vi } from "vitest";
import { createMemorySearchTool } from "../../tools/memory-search";
import type { Memory, RetrievalResult } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMem(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: randomUUID(),
    text: "Usa pnpm em todos os projetos",
    embedding: null,
    type: "preference",
    scope: "project",
    tags: ["#pnpm"],
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

function mockRetriever(results: RetrievalResult[]) {
  return {
    search: vi.fn(() => results),
  } as unknown as Parameters<typeof createMemorySearchTool>[0];
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("memory_search tool", () => {
  it("deve retornar resultados formatados", async () => {
    const mem = makeMem({ text: "Usa pnpm", type: "preference", scope: "project" });
    const retriever = mockRetriever([
      { memory: mem, score: 0.95, strategy: "bm25" },
    ]);

    const tool = createMemorySearchTool(retriever, "test-project");
    const result = await tool.execute(
      "id",
      { query: "package manager" },
      undefined,
      undefined,
      undefined
    );

    expect(result.content[0].text).toContain("[preference]");
    expect(result.content[0].text).toContain("Usa pnpm");
    expect(result.details.results).toHaveLength(1);
  });

  it("deve retornar 'No memories found' quando vazio", async () => {
    const retriever = mockRetriever([]);
    const tool = createMemorySearchTool(retriever, "test-project");

    const result = await tool.execute(
      "id",
      { query: "nada" },
      undefined,
      undefined,
      undefined
    );

    expect(result.content[0].text).toBe("No memories found.");
    expect(result.details.results).toEqual([]);
  });

  it("deve filtrar por type", async () => {
    const pref = makeMem({ text: "Pref", type: "preference" });
    const fact = makeMem({ text: "Fact", type: "fact" });
    const retriever = mockRetriever([
      { memory: pref, score: 1.0, strategy: "bm25" },
      { memory: fact, score: 0.5, strategy: "bm25" },
    ]);

    const tool = createMemorySearchTool(retriever, "test-project");
    const result = await tool.execute(
      "id",
      { query: "q", type: "preference" },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0].type).toBe("preference");
  });

  it("deve filtrar por scope", async () => {
    const proj = makeMem({ text: "Proj", scope: "project" });
    const user = makeMem({ text: "User", scope: "user" });
    const retriever = mockRetriever([
      { memory: proj, score: 1.0, strategy: "bm25" },
      { memory: user, score: 0.5, strategy: "bm25" },
    ]);

    const tool = createMemorySearchTool(retriever, "test-project");
    const result = await tool.execute(
      "id",
      { query: "q", scope: "user" },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0].scope).toBe("user");
  });

  it("deve filtrar por type e scope simultaneamente", async () => {
    const match = makeMem({ text: "Match", type: "preference", scope: "project" });
    const wrongType = makeMem({ text: "Wrong", type: "fact", scope: "project" });
    const wrongScope = makeMem({ text: "Wrong", type: "preference", scope: "user" });
    const retriever = mockRetriever([
      { memory: match, score: 1.0, strategy: "bm25" },
      { memory: wrongType, score: 0.5, strategy: "bm25" },
      { memory: wrongScope, score: 0.3, strategy: "bm25" },
    ]);

    const tool = createMemorySearchTool(retriever, "test-project");
    const result = await tool.execute(
      "id",
      { query: "q", type: "preference", scope: "project" },
      undefined,
      undefined,
      undefined
    );

    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0].text).toBe("Match");
  });

  it("deve incluir score e metadata nos results", async () => {
    const mem = makeMem({ text: "Test", confidence: 0.75 });
    const retriever = mockRetriever([
      { memory: mem, score: 0.88, strategy: "bm25" },
    ]);

    const tool = createMemorySearchTool(retriever, "test-project");
    const result = await tool.execute(
      "id",
      { query: "q" },
      undefined,
      undefined,
      undefined
    );

    const detail = result.details.results[0];
    expect(detail.id).toBe(mem.id);
    expect(detail.confidence).toBe(0.75);
    expect(detail.score).toBe(0.88);
  });

  it("deve passar projectId ao retriever", async () => {
    const retriever = mockRetriever([]);
    const tool = createMemorySearchTool(retriever, "my-project");

    await tool.execute("id", { query: "q" }, undefined, undefined, undefined);
    expect(retriever.search).toHaveBeenCalledWith("q", "my-project", 10);
  });
});
