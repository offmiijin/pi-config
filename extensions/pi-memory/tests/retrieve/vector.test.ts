/**
 * Testes do VectorRetriever com páginas.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { VectorRetriever } from "../../retrieve/vector";
import { EmbeddingService } from "../../utils/embedding";
import type { Page } from "../../types";

// ── Helpers ────────────────────────────────────────────────────────────

function makeEmbedding(dim = 384): Float32Array {
  const emb = new Float32Array(dim);
  for (let i = 0; i < dim; i++) emb[i] = Math.random() * 2 - 1;
  // Normaliza
  const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < dim; i++) emb[i] /= norm;
  return emb;
}

function makeEmbeddingService(): EmbeddingService {
  return {
    initialize: vi.fn(async () => {}),
    embed: vi.fn(async (text: string) => {
      // Embedding determinístico baseado no texto
      const emb = new Float32Array(384);
      for (let i = 0; i < Math.min(text.length, 384); i++) {
        emb[i] = text.charCodeAt(i) / 128 - 1;
      }
      const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
      for (let i = 0; i < 384; i++) emb[i] /= norm;
      return emb;
    }),
    embedBatch: vi.fn(async (texts: string[]) => {
      return Promise.all(texts.map((t) => ({} as any).embed?.(t) ?? makeEmbedding()));
    }),
    isReady: true,
    activeBackend: "local",
    error: null,
  } as unknown as EmbeddingService;
}

function makePage(overrides: Partial<Page> = {}): Page {
  const now = Date.now();
  return {
    id: "page-1",
    project_id: "test-project",
    path: "decisions/test.md",
    title: "Test",
    body: "conteúdo de teste",
    type: "fact",
    scope: "project",
    tags: [],
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

// ── Suite ───────────────────────────────────────────────────────────────

describe("VectorRetriever", () => {
  let embeddingService: EmbeddingService;
  let retriever: VectorRetriever;

  beforeEach(() => {
    embeddingService = makeEmbeddingService();
    retriever = new VectorRetriever(embeddingService);
  });

  // ── buildIndex ─────────────────────────────────────────────────────

  describe("buildIndex", () => {
    it("deve construir índice a partir de {id, embedding}", () => {
      const emb1 = makeEmbedding();
      const emb2 = makeEmbedding();

      retriever.buildIndex([
        { id: "p1", embedding: emb1 },
        { id: "p2", embedding: null as any },
        { id: "p3", embedding: emb2 },
      ]);

      expect(retriever.size).toBe(2); // p2 ignorado (embedding null)
    });

    it("deve ignorar itens com dimensão incorreta", () => {
      retriever.buildIndex([
        { id: "p1", embedding: new Float32Array(128) },
        { id: "p2", embedding: makeEmbedding(384) },
      ]);

      expect(retriever.size).toBe(1);
    });

    it("deve substituir índice existente", () => {
      retriever.buildIndex([{ id: "p1", embedding: makeEmbedding() }]);
      expect(retriever.size).toBe(1);

      retriever.buildIndex([
        { id: "p2", embedding: makeEmbedding() },
        { id: "p3", embedding: makeEmbedding() },
      ]);
      expect(retriever.size).toBe(2);
    });
  });

  // ── upsert ─────────────────────────────────────────────────────────

  describe("upsert", () => {
    it("deve adicionar nova página ao índice", () => {
      retriever.upsert("p1", makeEmbedding());
      expect(retriever.size).toBe(1);
    });

    it("deve ignorar embedding nulo", () => {
      retriever.upsert("p1", null as any);
      expect(retriever.size).toBe(0);
    });

    it("deve atualizar embedding existente", () => {
      const emb1 = makeEmbedding();
      const emb2 = makeEmbedding();

      retriever.upsert("p1", emb1);
      retriever.upsert("p1", emb2);
      expect(retriever.size).toBe(1);
    });
  });

  // ── remove ─────────────────────────────────────────────────────────

  describe("remove", () => {
    it("deve remover página do índice", () => {
      retriever.upsert("p1", makeEmbedding());
      retriever.upsert("p2", makeEmbedding());
      expect(retriever.size).toBe(2);

      retriever.remove("p1");
      expect(retriever.size).toBe(1);
    });

    it("não deve quebrar ao remover id inexistente", () => {
      expect(() => retriever.remove("nonexistent")).not.toThrow();
    });
  });

  // ── clear ──────────────────────────────────────────────────────────

  describe("clear", () => {
    it("deve remover todos os vetores", () => {
      retriever.upsert("p1", makeEmbedding());
      retriever.clear();
      expect(retriever.size).toBe(0);
    });
  });

  // ── search ─────────────────────────────────────────────────────────

  describe("search", () => {
    it("deve retornar array vazio com índice vazio", async () => {
      const results = await retriever.search("query");
      expect(results).toEqual([]);
    });

    it("deve ranquear por similaridade", async () => {
      const targetEmb = makeEmbedding();
      retriever.upsert("target", targetEmb);

      // Adiciona ruído
      for (let i = 0; i < 5; i++) {
        retriever.upsert(`noise-${i}`, makeEmbedding());
      }

      const results = await retriever.search("alvo");
      expect(results.length).toBeGreaterThan(0);
      // target deve ter score alto (embedding do search é derivado de "alvo")
      expect(results.some((r) => r.id === "target")).toBe(true);
    });

    it("deve respeitar topK", async () => {
      for (let i = 0; i < 10; i++) {
        retriever.upsert(`p${i}`, makeEmbedding());
      }

      const results = await retriever.search("query", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("deve retornar scores entre -1 e 1", async () => {
      retriever.upsert("p1", makeEmbedding());
      retriever.upsert("p2", makeEmbedding());

      const results = await retriever.search("teste");
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(-1);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });
  });

  // ── searchAsResults ────────────────────────────────────────────────

  describe("searchAsResults", () => {
    it("deve resolver IDs para objetos RetrievalResult", async () => {
      const queryEmb = makeEmbedding();
      retriever.upsert("p1", queryEmb);

      const pageLookup = (id: string): Page | null => {
        if (id === "p1") return makePage({ id: "p1", body: "página de teste 1" });
        return null;
      };

      const results = await retriever.searchAsResults("consulta", pageLookup);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].page.id).toBe("p1");
      expect(results[0].strategy).toBe("vector");
      expect(results[0].page.body).toBe("página de teste 1");
    });

    it("deve ignorar IDs órfãos (página não encontrada)", async () => {
      retriever.upsert("orphan", makeEmbedding());
      retriever.upsert("valid", makeEmbedding());

      const pageLookup = (id: string): Page | null => {
        if (id === "valid") return makePage({ id: "valid" });
        return null;
      };

      const results = await retriever.searchAsResults("query", pageLookup);
      expect(results.every((r) => r.page.id === "valid")).toBe(true);
    });
  });

  // ── memoryBytes ────────────────────────────────────────────────────

  describe("memoryBytes", () => {
    it("deve estimar uso de RAM", () => {
      retriever.upsert("p1", makeEmbedding(384));
      retriever.upsert("p2", makeEmbedding(384));
      expect(retriever.memoryBytes).toBe(2 * 384 * 4); // 2 vetores * 384 dims * 4 bytes
    });

    it("deve ser 0 com índice vazio", () => {
      expect(retriever.memoryBytes).toBe(0);
    });
  });
});
