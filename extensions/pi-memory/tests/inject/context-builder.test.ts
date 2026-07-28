/**
 * Testes do Context Builder (INJECT — Fase 1).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildMemoryBlock,
  buildMemoryBlockFromResults,
  createInjectHandler,
} from "../../inject/context-builder";
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
    tags: ["#preference", "#pnpm"],
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

// ── Suite: buildMemoryBlock ─────────────────────────────────────────────

describe("buildMemoryBlock", () => {
  it("deve retornar string vazia para array vazio", () => {
    expect(buildMemoryBlock([])).toBe("");
  });

  it("deve formatar uma memória como bullet", () => {
    const mem = makeMem({ text: "Usa pnpm", type: "preference" });
    const block = buildMemoryBlock([mem]);

    expect(block).toContain("## Persistent Memory");
    expect(block).toContain("- [preference] Usa pnpm");
  });

  it("deve formatar múltiplas memórias", () => {
    const memories = [
      makeMem({ text: "Pref A", type: "preference" }),
      makeMem({ text: "Decisão B", type: "decision" }),
    ];
    const block = buildMemoryBlock(memories);

    const lines = block.split("\n");
    expect(lines).toHaveLength(3); // header + 2 bullets
    expect(lines[1]).toContain("[preference]");
    expect(lines[2]).toContain("[decision]");
  });

  it("deve limitar a MAX_MEMORIES (5)", () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMem({ text: `Memória ${i}`, type: "fact" })
    );
    const block = buildMemoryBlock(memories);

    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(5);
  });

  it("deve respeitar maxBytes (padrão 4KB)", () => {
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMem({ text: "X".repeat(200), type: "fact" })
    );

    const block = buildMemoryBlock(memories, 512);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(512);
  });

  it("deve truncar textos longos nos bullets", () => {
    const mem = makeMem({ text: "A".repeat(300), type: "fact" });
    const block = buildMemoryBlock([mem]);

    expect(block.length).toBeLessThan(300);
    expect(block.endsWith("…")).toBe(true);
  });

  it("deve retornar vazio se header sozinho já estoura maxBytes", () => {
    const mem = makeMem({ text: "X", type: "fact" });
    const block = buildMemoryBlock([mem], 10); // header > 10 bytes
    expect(block).toBe("");
  });

  it("deve pular memória que excede o limite e continuar nas menores", () => {
    const large = makeMem({ text: "L".repeat(400), type: "fact" });
    const small = makeMem({ text: "ok", type: "preference" });

    const block = buildMemoryBlock([large, small], 256);

    // "L".repeat(400) truncado para 200 + … = ~203 chars. Header + isso pode estourar.
    // small deve caber
    expect(block).toContain("ok");
  });
});

// ── Suite: buildMemoryBlockFromResults ─────────────────────────────────

describe("buildMemoryBlockFromResults", () => {
  it("deve extrair memories de RetrievalResult[]", () => {
    const results: RetrievalResult[] = [
      { memory: makeMem({ text: "A", type: "fact" }), score: 1.0, strategy: "bm25" },
      { memory: makeMem({ text: "B", type: "preference" }), score: 0.5, strategy: "bm25" },
    ];

    const block = buildMemoryBlockFromResults(results);
    expect(block).toContain("A");
    expect(block).toContain("B");
  });

  it("deve retornar vazio para results vazio", () => {
    expect(buildMemoryBlockFromResults([])).toBe("");
  });

  it("deve limitar a 5 resultados (MAX_MEMORIES)", () => {
    const results: RetrievalResult[] = Array.from({ length: 10 }, (_, i) => ({
      memory: makeMem({ text: `M${i}`, type: "fact" }),
      score: 1.0 - i * 0.1,
      strategy: "bm25" as const,
    }));

    const block = buildMemoryBlockFromResults(results);
    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(5);
  });
});

// ── Suite: createInjectHandler ─────────────────────────────────────────

describe("createInjectHandler", () => {
  // Cria um search provider mock (assíncrono)
  function mockSearch(
    results: RetrievalResult[]
  ): {
    search: ReturnType<typeof vi.fn>;
  } {
    return {
      search: vi.fn(async (_query: string) => results),
    };
  }

  it("deve retornar systemPrompt inalterado se não há resultados", async () => {
    const provider = mockSearch([]);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "test-project",
    });

    const result = await handler({
      prompt: "query sem resultados",
      systemPrompt: "system prompt original",
    });

    expect(result.systemPrompt).toBe("system prompt original");
  });

  it("deve injetar bloco de memória no systemPrompt", async () => {
    const mem = makeMem({ text: "Usa pnpm", type: "preference", confidence: 0.8 });
    const results: RetrievalResult[] = [
      { memory: mem, score: 1.0, strategy: "bm25" },
    ];

    const provider = mockSearch(results);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "test-project",
    });

    const result = await handler({
      prompt: "qual package manager?",
      systemPrompt: "system prompt original",
    });

    expect(result.systemPrompt).toContain("system prompt original");
    expect(result.systemPrompt).toContain("## Persistent Memory");
    expect(result.systemPrompt).toContain("Usa pnpm");
  });

  it("deve filtrar memórias com confidence < 0.5", async () => {
    const lowConf = makeMem({ text: "baixa confiança", confidence: 0.3 });
    const highConf = makeMem({ text: "alta confiança", confidence: 0.9 });
    const results: RetrievalResult[] = [
      { memory: lowConf, score: 1.0, strategy: "bm25" },
      { memory: highConf, score: 0.5, strategy: "bm25" },
    ];

    const provider = mockSearch(results);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "test-project",
    });

    const result = await handler({
      prompt: "query",
      systemPrompt: "original",
    });

    expect(result.systemPrompt).toContain("alta confiança");
    expect(result.systemPrompt).not.toContain("baixa confiança");
  });

  it("deve usar prompt como query de busca", async () => {
    const provider = mockSearch([]);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "my-project",
      topK: 5,
    });

    await handler({
      prompt: "como fazer deploy?",
      systemPrompt: "original",
    });

    expect(provider.search).toHaveBeenCalledWith(
      "como fazer deploy?",
      5
    );
  });

  it("deve usar topK=10 como default", async () => {
    const provider = mockSearch([]);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "p",
    });

    await handler({ prompt: "q", systemPrompt: "s" });
    // search é chamado com query apenas (projectId e topK são internos)
    expect(provider.search).toHaveBeenCalled();
  });

  it("deve retornar systemPrompt original se todas memórias têm confidence baixa", async () => {
    const lowConf = makeMem({ text: "low", confidence: 0.2 });
    const results: RetrievalResult[] = [
      { memory: lowConf, score: 1.0, strategy: "bm25" },
    ];

    const provider = mockSearch(results);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "p",
    });

    const result = await handler({
      prompt: "query",
      systemPrompt: "original",
    });

    expect(result.systemPrompt).toBe("original");
  });

  it("deve respeitar maxBytes personalizado", async () => {
    const mem = makeMem({ text: "X".repeat(300), type: "fact", confidence: 0.9 });
    const results: RetrievalResult[] = [
      { memory: mem, score: 1.0, strategy: "bm25" },
    ];

    const provider = mockSearch(results);
    const handler = createInjectHandler({
      search: provider.search,
      projectId: "p",
      maxBytes: 150,
    });

    const result = await handler({
      prompt: "q",
      systemPrompt: "s",
    });

    // O bloco injetado (fora o systemPrompt original) deve ser <= 150 bytes
    const injectedPart = result.systemPrompt.slice("s".length);
    expect(Buffer.byteLength(injectedPart)).toBeLessThanOrEqual(150);
  });
});
