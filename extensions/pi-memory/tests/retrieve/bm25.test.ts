/**
 * Testes do Bm25Retriever.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Bm25Retriever } from "../../retrieve/bm25";
import type { IStorage } from "../../storage/index";
import type { Memory, RetrievalResult } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMockStorage(
  searchResults: Array<{ memory: Memory; bm25Score: number }> = []
): IStorage {
  return {
    open: vi.fn(),
    close: vi.fn(),
    insertMemory: vi.fn(),
    getMemory: vi.fn(() => null),
    getMemoriesByProject: vi.fn(() => []),
    getMemoryByHash: vi.fn(() => null),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn(),
    getObservations: vi.fn(() => []),
    getPendingObservations: vi.fn(() => []),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(() => 0),
    searchFts: vi.fn(() => searchResults),
    countMemories: vi.fn(() => 0),
    countObservations: vi.fn(() => 0),
    countPendingExtraction: vi.fn(() => 0),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(() => []),
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
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

// ── Suite ───────────────────────────────────────────────────────────────

describe("Bm25Retriever", () => {
  let retriever: Bm25Retriever;

  beforeEach(() => {
    const storage = makeMockStorage();
    retriever = new Bm25Retriever(storage);
  });

  // ── search ─────────────────────────────────────────────────────────

  describe("search", () => {
    it("deve retornar array vazio quando não há resultados", () => {
      const storage = makeMockStorage([]);
      const r = new Bm25Retriever(storage);

      const results = r.search("query", "project");
      expect(results).toEqual([]);
    });

    it("deve retornar resultados com strategy=bm25", () => {
      const mem = makeMemory({ text: "docker compose" });
      const storage = makeMockStorage([{ memory: mem, bm25Score: -2.5 }]);
      const r = new Bm25Retriever(storage);

      const results = r.search("docker", "test-project");
      expect(results).toHaveLength(1);
      expect(results[0].strategy).toBe("bm25");
      expect(results[0].memory.id).toBe(mem.id);
    });

    it("deve normalizar score para 1.0 quando há 1 resultado", () => {
      const mem = makeMemory();
      const storage = makeMockStorage([{ memory: mem, bm25Score: -5.0 }]);
      const r = new Bm25Retriever(storage);

      const results = r.search("query", "test-project");
      expect(results[0].score).toBe(1.0);
    });

    it("deve normalizar scores para range 0-1 com múltiplos resultados", () => {
      const mem1 = makeMemory({ text: "A" });
      const mem2 = makeMemory({ text: "B" });
      const mem3 = makeMemory({ text: "C" });
      const storage = makeMockStorage([
        { memory: mem1, bm25Score: -1.0 }, // melhor
        { memory: mem2, bm25Score: -3.0 }, // médio
        { memory: mem3, bm25Score: -5.0 }, // pior
      ]);
      const r = new Bm25Retriever(storage);

      const results = r.search("query", "test-project");
      expect(results).toHaveLength(3);

      // Melhor score = 1.0
      expect(results[0].score).toBe(1.0);
      // Pior score = 0.0
      expect(results[2].score).toBeCloseTo(0.0, 1);
      // Médio deve estar entre 0 e 1
      expect(results[1].score).toBeGreaterThan(0);
      expect(results[1].score).toBeLessThan(1);
    });

    it("deve normalizar para 0.5 quando todos scores são iguais", () => {
      const mem1 = makeMemory({ text: "A" });
      const mem2 = makeMemory({ text: "B" });
      const storage = makeMockStorage([
        { memory: mem1, bm25Score: -3.0 },
        { memory: mem2, bm25Score: -3.0 },
      ]);
      const r = new Bm25Retriever(storage);

      const results = r.search("query", "test-project");
      expect(results[0].score).toBe(0.5);
      expect(results[1].score).toBe(0.5);
    });

    it("deve repassar projectId e topK ao storage", () => {
      const storage = makeMockStorage([]);
      const r = new Bm25Retriever(storage);

      r.search("query", "my-project", 5);

      expect(storage.searchFts).toHaveBeenCalledWith("query", "my-project", 5);
    });

    it("deve usar topK=10 como default", () => {
      const storage = makeMockStorage([]);
      const r = new Bm25Retriever(storage);

      r.search("query", "project");

      expect(storage.searchFts).toHaveBeenCalledWith("query", "project", 10);
    });
  });

  // ── formatResults ──────────────────────────────────────────────────

  describe("formatResults", () => {
    it("deve retornar string vazia para array vazio", () => {
      expect(retriever.formatResults([])).toBe("");
    });

    it("deve formatar bullet com tipo e texto", () => {
      const mem = makeMemory({ text: "Usa pnpm", type: "preference" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 1.0, strategy: "bm25" },
      ];

      const formatted = retriever.formatResults(results);
      expect(formatted).toBe("- [preference] Usa pnpm");
    });

    it("deve truncar textos longos", () => {
      const longText = "A".repeat(300);
      const mem = makeMemory({ text: longText, type: "fact" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 1.0, strategy: "bm25" },
      ];

      const formatted = retriever.formatResults(results);
      const bullet = formatted.split("\n")[0];
      expect(bullet.length).toBeLessThan(300);
      expect(bullet.endsWith("…")).toBe(true);
    });

    it("deve respeitar maxResults", () => {
      const results: RetrievalResult[] = [];
      for (let i = 0; i < 10; i++) {
        results.push({
          memory: makeMemory({ text: `Memória ${i}`, type: "fact" }),
          score: 1.0 - i * 0.1,
          strategy: "bm25",
        });
      }

      const formatted = retriever.formatResults(results, 3);
      const bullets = formatted.split("\n");
      expect(bullets).toHaveLength(3);
    });

    it("deve agrupar por tipo (preference antes de fact)", () => {
      const results: RetrievalResult[] = [
        {
          memory: makeMemory({ text: "Fato 1", type: "fact" }),
          score: 1.0,
          strategy: "bm25",
        },
        {
          memory: makeMemory({ text: "Pref 1", type: "preference" }),
          score: 0.9,
          strategy: "bm25",
        },
        {
          memory: makeMemory({ text: "Decisão 1", type: "decision" }),
          score: 0.8,
          strategy: "bm25",
        },
      ];

      const formatted = retriever.formatResults(results);
      const lines = formatted.split("\n");
      // preference vem antes de decision, que vem antes de fact
      expect(lines[0]).toContain("[preference]");
      expect(lines[1]).toContain("[decision]");
      expect(lines[2]).toContain("[fact]");
    });

    it("deve ordenar por relevância dentro do agrupamento (score não afeta sort, é só por tipo)", () => {
      const results: RetrievalResult[] = [
        {
          memory: makeMemory({ text: "B", type: "fact" }),
          score: 1.0,
          strategy: "bm25",
        },
        {
          memory: makeMemory({ text: "A", type: "fact" }),
          score: 0.5,
          strategy: "bm25",
        },
      ];

      const formatted = retriever.formatResults(results);
      const lines = formatted.split("\n");
      // Ambos fact, ordem de entrada preservada (não reordena por score)
      expect(lines[0]).toContain("B");
      expect(lines[1]).toContain("A");
    });
  });

  // ── formatContextBlock ─────────────────────────────────────────────

  describe("formatContextBlock", () => {
    it("deve retornar string vazia para array vazio", () => {
      expect(retriever.formatContextBlock([])).toBe("");
    });

    it("deve incluir cabeçalho e bullets", () => {
      const mem = makeMemory({ text: "Usa pnpm", type: "preference" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 1.0, strategy: "bm25" },
      ];

      const block = retriever.formatContextBlock(results);
      expect(block).toContain("## Persistent Memory");
      expect(block).toContain("- [preference] Usa pnpm");
    });

    it("deve respeitar maxBytes (padrão 4KB)", () => {
      const results: RetrievalResult[] = [];
      for (let i = 0; i < 20; i++) {
        results.push({
          memory: makeMemory({ text: "X".repeat(200), type: "fact" }),
          score: 1.0,
          strategy: "bm25",
        });
      }

      const block = retriever.formatContextBlock(results, 512);
      expect(Buffer.byteLength(block)).toBeLessThanOrEqual(512);
    });

    it("deve truncar memórias que excedem o limite", () => {
      const results: RetrievalResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push({
          memory: makeMemory({ text: "Memória importante " + i, type: "fact" }),
          score: 1.0,
          strategy: "bm25",
        });
      }

      const block = retriever.formatContextBlock(results, 200);
      // Deve ter pelo menos 1 bullet (header + 1 bullet)
      expect(block.split("\n").length).toBeGreaterThanOrEqual(2);
      expect(Buffer.byteLength(block)).toBeLessThanOrEqual(200);
    });

    it("deve parar de adicionar bullets quando estoura o limite", () => {
      const results: RetrievalResult[] = [
        {
          memory: makeMemory({ text: "A".repeat(100), type: "fact" }),
          score: 1.0,
          strategy: "bm25",
        },
        {
          memory: makeMemory({ text: "B".repeat(100), type: "preference" }),
          score: 0.9,
          strategy: "bm25",
        },
        {
          memory: makeMemory({ text: "C".repeat(100), type: "decision" }),
          score: 0.8,
          strategy: "bm25",
        },
      ];

      const block = retriever.formatContextBlock(results, 250);
      // Só deve caber header + 1 ou 2 bullets
      const lines = block.split("\n").filter((l) => l.startsWith("- "));
      expect(lines.length).toBeLessThanOrEqual(2);
    });
  });

  // ── truncateText (via formatResults) ───────────────────────────────

  describe("truncateText", () => {
    it("não deve truncar texto curto", () => {
      const mem = makeMemory({ text: "Curto", type: "fact" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 1.0, strategy: "bm25" },
      ];
      const formatted = retriever.formatResults(results);
      expect(formatted).toContain("Curto");
      expect(formatted.endsWith("…")).toBe(false);
    });

    it("deve truncar e adicionar … no final", () => {
      const mem = makeMemory({ text: "X".repeat(300), type: "fact" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 1.0, strategy: "bm25" },
      ];
      const formatted = retriever.formatResults(results);
      expect(formatted.endsWith("…")).toBe(true);
    });
  });
});
