/**
 * Testes do HybridRetriever (Fase 2.5).
 *
 * Cobre: pipeline completo (BM25 + Vector + RRF + Reranker),
 * graceful degradation (sem vector, sem reranker),
 * activeComponents, searchSync fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HybridRetriever } from "../../retrieve/index";
import { Bm25Retriever } from "../../retrieve/bm25";
import { VectorRetriever } from "../../retrieve/vector";
import { RerankerService } from "../../retrieve/reranker";
import { EmbeddingService } from "../../utils/embedding";
import type { Memory, RetrievalResult } from "../../types";
import type { IStorage } from "../../storage/index";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMem(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    text: "test memory",
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
    project_id: "proj-1",
    content_hash: "abc",
    ...overrides,
  };
}

function makeEmbedding(dim = 384): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  let sumSq = 0;
  for (let i = 0; i < dim; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function makeBm25(results: RetrievalResult[]): Bm25Retriever {
  return {
    search: vi.fn(() => results),
    formatResults: vi.fn(),
    formatContextBlock: vi.fn(),
  } as unknown as Bm25Retriever;
}

function makeVector(memories: Memory[]): VectorRetriever {
  const emb = makeEmbedding();
  const embSvc = {
    embed: vi.fn().mockResolvedValue(emb),
    embedBatch: vi.fn(),
    initialize: vi.fn(),
    isReady: true,
    activeBackend: "local",
    error: null,
  } as unknown as EmbeddingService;
  const vr = new VectorRetriever(embSvc);
  for (const m of memories) {
    vr.upsert({ ...m, embedding: makeEmbedding() });
  }
  return vr;
}

function makeStorage(memories: Memory[]): IStorage {
  const map = new Map(memories.map((m) => [m.id, m]));
  return {
    getMemory: vi.fn((id: string) => map.get(id) ?? null),
    getMemoriesByProject: vi.fn(() => memories),
    searchFts: vi.fn(() => []),
    open: vi.fn(),
    close: vi.fn(),
    insertMemory: vi.fn(),
    getMemoryByHash: vi.fn(),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn(),
    getObservations: vi.fn(),
    getPendingObservations: vi.fn(),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(),
    countMemories: vi.fn(),
    countObservations: vi.fn(),
    countPendingExtraction: vi.fn(),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(),
    getMemoriesWithEmbeddings: vi.fn(),
    getMemoriesWithoutEmbedding: vi.fn(),
    updateEmbedding: vi.fn(),
  } as unknown as IStorage;
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("HybridRetriever", () => {
  describe("activeComponents", () => {
    it("deve reportar bm25 sempre ativo", () => {
      const bm25 = makeBm25([]);
      const storage = makeStorage([]);
      const hr = new HybridRetriever(bm25, storage, "proj-1");
      expect(hr.activeComponents.bm25).toBe(true);
    });

    it("deve reportar vector inativo se não fornecido", () => {
      const bm25 = makeBm25([]);
      const storage = makeStorage([]);
      const hr = new HybridRetriever(bm25, storage, "proj-1", null);
      expect(hr.activeComponents.vector).toBe(false);
    });

    it("deve reportar vector ativo se fornecido e enabled", () => {
      const bm25 = makeBm25([]);
      const mem = makeMem({ id: "m1" });
      const vr = makeVector([mem]);
      const storage = makeStorage([mem]);
      const hr = new HybridRetriever(bm25, storage, "proj-1", vr, null, {
        vectorEnabled: true,
      });
      expect(hr.activeComponents.vector).toBe(true);
    });

    it("deve reportar reranker inativo se não fornecido", () => {
      const bm25 = makeBm25([]);
      const storage = makeStorage([]);
      const hr = new HybridRetriever(bm25, storage, "proj-1");
      expect(hr.activeComponents.reranker).toBe(false);
    });

    it("deve reportar vector inativo quando vectorEnabled=false", () => {
      const bm25 = makeBm25([]);
      const mem = makeMem({ id: "m1" });
      const vr = makeVector([mem]);
      const storage = makeStorage([mem]);
      const hr = new HybridRetriever(bm25, storage, "proj-1", vr, null, {
        vectorEnabled: false,
      });
      expect(hr.activeComponents.vector).toBe(false);
    });
  });

  describe("search (BM25-only)", () => {
    it("deve retornar resultados BM25 sem vector", async () => {
      const mem = makeMem({ id: "m1", text: "Usa pnpm" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 0.9, strategy: "bm25" },
      ];
      const bm25 = makeBm25(results);
      const storage = makeStorage([mem]);
      const hr = new HybridRetriever(bm25, storage, "proj-1");

      const output = await hr.search("package manager", 5);
      expect(output).toHaveLength(1);
      expect(output[0].memory.text).toBe("Usa pnpm");
    });

    it("deve retornar array vazio quando BM25 não encontra nada", async () => {
      const bm25 = makeBm25([]);
      const storage = makeStorage([]);
      const hr = new HybridRetriever(bm25, storage, "proj-1");

      const output = await hr.search("query", 5);
      expect(output).toEqual([]);
    });

    it("deve respeitar topK", async () => {
      const results: RetrievalResult[] = Array.from({ length: 10 }, (_, i) => ({
        memory: makeMem({ id: `m${i}`, text: `Memory ${i}` }),
        score: 1.0 - i * 0.1,
        strategy: "bm25" as const,
      }));
      const bm25 = makeBm25(results);
      const storage = makeStorage(results.map((r) => r.memory));
      const hr = new HybridRetriever(bm25, storage, "proj-1");

      const output = await hr.search("query", 3);
      expect(output).toHaveLength(3);
    });
  });

  describe("search (BM25 + Vector)", () => {
    it("deve fusionar BM25 e Vector via RRF", async () => {
      const bm25Mem = makeMem({ id: "bm25-1", text: "BM25 result" });
      const vecMem = makeMem({ id: "vec-1", text: "Vector result" });
      const sharedMem = makeMem({ id: "shared", text: "Both found" });

      const bm25Results: RetrievalResult[] = [
        { memory: sharedMem, score: 1.0, strategy: "bm25" },
        { memory: bm25Mem, score: 0.5, strategy: "bm25" },
      ];

      const bm25 = makeBm25(bm25Results);
      const vr = makeVector([vecMem, sharedMem]);
      const storage = makeStorage([bm25Mem, vecMem, sharedMem]);
      const hr = new HybridRetriever(bm25, storage, "proj-1", vr, null, {
        vectorEnabled: true,
      });

      const output = await hr.search("query", 10);
      // Deve conter itens de ambas estratégias
      const ids = output.map((r) => r.memory.id);
      expect(ids).toContain("shared"); // aparece em ambos
      expect(output[0].strategy).toBe("hybrid");
    });

    it("não deve quebrar se vector search falha", async () => {
      const bm25Mem = makeMem({ id: "m1", text: "Only BM25" });
      const bm25Results: RetrievalResult[] = [
        { memory: bm25Mem, score: 1.0, strategy: "bm25" },
      ];
      const bm25 = makeBm25(bm25Results);

      // Vector que lança erro
      const badVector = {
        searchAsResults: vi.fn().mockRejectedValue(new Error("fail")),
        search: vi.fn().mockRejectedValue(new Error("fail")),
        buildIndex: vi.fn(),
        upsert: vi.fn(),
        remove: vi.fn(),
        size: 0,
        searchByVector: vi.fn(),
        memoryBytes: 0,
      } as unknown as VectorRetriever;

      const storage = makeStorage([bm25Mem]);
      const hr = new HybridRetriever(bm25, storage, "proj-1", badVector, null, {
        vectorEnabled: true,
      });

      const output = await hr.search("query", 5);
      // Deve retornar apenas BM25
      expect(output).toHaveLength(1);
      expect(output[0].memory.id).toBe("m1");
    });
  });

  describe("searchSync", () => {
    it("deve delegar para BM25", () => {
      const mem = makeMem({ id: "m1", text: "Sync result" });
      const results: RetrievalResult[] = [
        { memory: mem, score: 1.0, strategy: "bm25" },
      ];
      const bm25 = makeBm25(results);
      const storage = makeStorage([mem]);
      const hr = new HybridRetriever(bm25, storage, "proj-1");

      const output = hr.searchSync("query", 5);
      expect(output).toHaveLength(1);
      expect(output[0].memory.id).toBe("m1");
    });
  });

  describe("config", () => {
    it("deve usar candidatesPerStrategy padrão (20)", async () => {
      const bm25 = makeBm25([]);
      const storage = makeStorage([]);
      const hr = new HybridRetriever(bm25, storage, "proj-1");

      await hr.search("query", 10);
      expect(bm25.search).toHaveBeenCalledWith("query", "proj-1", 20);
    });

    it("deve aceitar candidatesPerStrategy customizado", async () => {
      const bm25 = makeBm25([]);
      const storage = makeStorage([]);
      const hr = new HybridRetriever(bm25, storage, "proj-1", null, null, {
        candidatesPerStrategy: 5,
      });

      await hr.search("query", 10);
      expect(bm25.search).toHaveBeenCalledWith("query", "proj-1", 5);
    });
  });
});
