/**
 * Testes do Bm25Retriever com páginas.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Bm25Retriever } from "../../retrieve/bm25";
import type { IStorage } from "../../storage/index";
import type { Page, RetrievalResult } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMockStorage(
  searchResults: RetrievalResult[] = []
): IStorage {
  return {
    open: vi.fn(),
    close: vi.fn(),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn(),
    getObservations: vi.fn(() => []),
    getPendingObservations: vi.fn(() => []),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(() => 0),
    insertPage: vi.fn(),
    updatePage: vi.fn(),
    deletePage: vi.fn(),
    deleteAllPages: vi.fn(() => 0),
    deleteAllObservations: vi.fn(() => 0),
    getPage: vi.fn(() => null),
    getPageById: vi.fn(() => null),
    getPagesByProject: vi.fn(() => []),
    pageExists: vi.fn(() => false),
    searchPagesFts: vi.fn(() => searchResults),
    getPagesWithEmbeddings: vi.fn(() => []),
    getPagesWithEmbeddingData: vi.fn(() => []),
    getPagesWithoutEmbedding: vi.fn(() => []),
    updatePageEmbedding: vi.fn(),
    countPages: vi.fn(() => 0),
    countObservations: vi.fn(() => 0),
    countPendingExtraction: vi.fn(() => 0),
  } as unknown as IStorage;
}

function makePage(overrides: Partial<Page> = {}): Page {
  const now = Date.now();
  return {
    id: randomUUID(),
    project_id: "test-project",
    path: "preferences/pnpm.md",
    title: "Prefere pnpm",
    body: "Usa pnpm em todos os projetos",
    type: "preference",
    scope: "project",
    tags: ["pnpm"],
    confidence: 0.8,
    status: "active",
    pinned: false,
    supersedes: null,
    created_at: now,
    updated_at: now,
    content_hash: "abc",
    mtime: now,
    ...overrides,
  };
}

function makeResult(page: Page, score = 1.0): RetrievalResult {
  return { page, snippet: page.body.slice(0, 300), score, strategy: "fts5" };
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

    it("deve retornar resultados com strategy=fts5", () => {
      const page = makePage({ body: "docker compose" });
      const storage = makeMockStorage([makeResult(page)]);
      const r = new Bm25Retriever(storage);

      const results = r.search("docker", "test-project");
      expect(results).toHaveLength(1);
      expect(results[0].strategy).toBe("fts5");
      expect(results[0].page.id).toBe(page.id);
    });

    it("deve normalizar score para 1.0 quando há 1 resultado", () => {
      const page = makePage();
      const storage = makeMockStorage([makeResult(page, 0.3)]);
      const r = new Bm25Retriever(storage);

      const results = r.search("query", "test-project");
      expect(results[0].score).toBe(1.0);
    });

    it("deve normalizar scores para range 0-1 com múltiplos resultados", () => {
      const p1 = makePage({ body: "A" });
      const p2 = makePage({ body: "B" });
      const p3 = makePage({ body: "C" });
      const storage = makeMockStorage([
        makeResult(p1, 0.9),
        makeResult(p2, 0.5),
        makeResult(p3, 0.1),
      ]);
      const r = new Bm25Retriever(storage);

      const results = r.search("query", "test-project");
      expect(results).toHaveLength(3);
      expect(results[0].score).toBe(1.0);
      expect(results[2].score).toBeCloseTo(0.0, 1);
    });

    it("deve normalizar para 0.5 quando todos scores são iguais", () => {
      const p1 = makePage({ body: "A" });
      const p2 = makePage({ body: "B" });
      const storage = makeMockStorage([
        makeResult(p1, 0.5),
        makeResult(p2, 0.5),
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
      expect(storage.searchPagesFts).toHaveBeenCalledWith("query", "my-project", 5);
    });

    it("deve usar topK=10 como default", () => {
      const storage = makeMockStorage([]);
      const r = new Bm25Retriever(storage);
      r.search("query", "project");
      expect(storage.searchPagesFts).toHaveBeenCalledWith("query", "project", 10);
    });
  });

  // ── formatResults ──────────────────────────────────────────────────

  describe("formatResults", () => {
    it("deve retornar string vazia para array vazio", () => {
      expect(retriever.formatResults([])).toBe("");
    });

    it("deve formatar bullet com tipo e body", () => {
      const page = makePage({ body: "Usa pnpm", type: "preference" });
      const results = [makeResult(page)];

      const formatted = retriever.formatResults(results);
      expect(formatted).toBe("- [preference] Usa pnpm");
    });

    it("deve truncar textos longos", () => {
      const longText = "A".repeat(300);
      const page = makePage({ body: longText, type: "fact" });
      const results = [makeResult(page)];

      const formatted = retriever.formatResults(results);
      const bullet = formatted.split("\n")[0];
      expect(bullet.length).toBeLessThan(300);
      expect(bullet.endsWith("…")).toBe(true);
    });

    it("deve respeitar maxResults", () => {
      const results: RetrievalResult[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(makeResult(makePage({ body: `Página ${i}`, type: "fact" }), 1.0 - i * 0.1));
      }

      const formatted = retriever.formatResults(results, 3);
      const bullets = formatted.split("\n");
      expect(bullets).toHaveLength(3);
    });

    it("deve agrupar por tipo (preference antes de fact)", () => {
      const results: RetrievalResult[] = [
        makeResult(makePage({ body: "Fato 1", type: "fact" }), 1.0),
        makeResult(makePage({ body: "Pref 1", type: "preference" }), 0.9),
        makeResult(makePage({ body: "Decisão 1", type: "decision" }), 0.8),
      ];

      const formatted = retriever.formatResults(results);
      const lines = formatted.split("\n");
      expect(lines[0]).toContain("[preference]");
      expect(lines[1]).toContain("[decision]");
      expect(lines[2]).toContain("[fact]");
    });
  });

  // ── formatContextBlock ─────────────────────────────────────────────

  describe("formatContextBlock", () => {
    it("deve retornar string vazia para array vazio", () => {
      expect(retriever.formatContextBlock([])).toBe("");
    });

    it("deve incluir cabeçalho e bullets", () => {
      const page = makePage({ body: "Usa pnpm", type: "preference" });
      const block = retriever.formatContextBlock([makeResult(page)]);
      expect(block).toContain("## Persistent Memory");
      expect(block).toContain("- [preference] Usa pnpm");
    });

    it("deve respeitar maxBytes", () => {
      const results: RetrievalResult[] = [];
      for (let i = 0; i < 20; i++) {
        results.push(makeResult(makePage({ body: "X".repeat(200), type: "fact" })));
      }

      const block = retriever.formatContextBlock(results, 512);
      expect(Buffer.byteLength(block)).toBeLessThanOrEqual(512);
    });

    it("deve truncar ao estourar limite", () => {
      const results = [
        makeResult(makePage({ body: "A".repeat(100), type: "fact" })),
        makeResult(makePage({ body: "B".repeat(100), type: "preference" })),
        makeResult(makePage({ body: "C".repeat(100), type: "decision" })),
      ];

      const block = retriever.formatContextBlock(results, 250);
      const lines = block.split("\n").filter((l) => l.startsWith("- "));
      expect(lines.length).toBeLessThanOrEqual(2);
    });
  });
});
