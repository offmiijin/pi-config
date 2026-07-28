/**
 * Testes do VectorRetriever.
 *
 * Cobre: buildIndex, upsert, remove, searchByVector, memoryBytes.
 * Testes de search() assíncrono dependem de EmbeddingService mockado.
 */

import { describe, it, expect, vi } from "vitest";
import { VectorRetriever } from "../../retrieve/vector";
import type { Memory } from "../../types";
import type { EmbeddingService } from "../../utils/embedding";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    text: "test memory",
    embedding: null,
    type: "fact",
    scope: "project",
    tags: [],
    confidence: 0.8,
    timestamp: Date.now(),
    last_accessed: Date.now(),
    access_count: 1,
    source_ids: [],
    superseded_by: null,
    pinned: false,
    project_id: "proj-1",
    content_hash: "abc123",
    ...overrides,
  };
}

function makeEmbedding(dim = 384): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
  }
  // Normalize
  let sumSq = 0;
  for (let i = 0; i < dim; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function makeMockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn(),
    embedBatch: vi.fn(),
    initialize: vi.fn(),
    isReady: true,
    activeBackend: "local",
    error: null,
  } as unknown as EmbeddingService;
}

// ── buildIndex ─────────────────────────────────────────────────────────

describe("VectorRetriever.buildIndex", () => {
  it("deve criar índice vazio se array vazio", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);
    vr.buildIndex([]);
    expect(vr.size).toBe(0);
  });

  it("deve indexar apenas memórias com embedding", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    const m1 = makeMemory({ id: "m1", embedding: makeEmbedding() });
    const m2 = makeMemory({ id: "m2", embedding: null });
    const m3 = makeMemory({ id: "m3", embedding: makeEmbedding() });

    vr.buildIndex([m1, m2, m3]);
    expect(vr.size).toBe(2);
  });

  it("deve ignorar embeddings com dimensão incorreta", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc, 384);

    const m1 = makeMemory({ id: "m1", embedding: new Float32Array(128) }); // dim errada
    const m2 = makeMemory({ id: "m2", embedding: makeEmbedding(384) });    // dim correta

    vr.buildIndex([m1, m2]);
    expect(vr.size).toBe(1);
  });

  it("deve sobrescrever índice em rebuild", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    vr.buildIndex([makeMemory({ id: "m1", embedding: makeEmbedding() })]);
    expect(vr.size).toBe(1);

    vr.buildIndex([
      makeMemory({ id: "m2", embedding: makeEmbedding() }),
      makeMemory({ id: "m3", embedding: makeEmbedding() }),
    ]);
    expect(vr.size).toBe(2);
  });
});

// ── upsert ─────────────────────────────────────────────────────────────

describe("VectorRetriever.upsert", () => {
  it("deve adicionar nova memória ao índice", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    const mem = makeMemory({ id: "m1", embedding: makeEmbedding() });
    vr.upsert(mem);
    expect(vr.size).toBe(1);
  });

  it("deve ignorar memória sem embedding", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    vr.upsert(makeMemory({ id: "m1", embedding: null }));
    expect(vr.size).toBe(0);
  });

  it("deve atualizar embedding de memória existente", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    const emb1 = makeEmbedding();
    const emb2 = makeEmbedding();

    vr.upsert(makeMemory({ id: "m1", embedding: emb1 }));
    vr.upsert(makeMemory({ id: "m1", embedding: emb2 }));

    expect(vr.size).toBe(1); // não duplica
  });
});

// ── remove ─────────────────────────────────────────────────────────────

describe("VectorRetriever.remove", () => {
  it("deve remover memória do índice", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    vr.upsert(makeMemory({ id: "m1", embedding: makeEmbedding() }));
    vr.upsert(makeMemory({ id: "m2", embedding: makeEmbedding() }));
    expect(vr.size).toBe(2);

    vr.remove("m1");
    expect(vr.size).toBe(1);
  });

  it("não deve quebrar ao remover ID inexistente", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    vr.upsert(makeMemory({ id: "m1", embedding: makeEmbedding() }));
    vr.remove("m2"); // não existe
    expect(vr.size).toBe(1);
  });
});

// ── searchByVector ─────────────────────────────────────────────────────

describe("VectorRetriever.searchByVector", () => {
  it("deve retornar array vazio se índice vazio", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    const results = vr.searchByVector(makeEmbedding(), 10);
    expect(results).toHaveLength(0);
  });

  it("deve retornar top-K resultados", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    // Cria 5 memórias com embeddings aleatórios
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `m${i}`;
      ids.push(id);
      vr.upsert(makeMemory({ id, embedding: makeEmbedding() }));
    }

    const results = vr.searchByVector(makeEmbedding(), 3);
    expect(results).toHaveLength(3);
    // Scores devem estar entre -1 e 1 (vetores normalizados → dot product)
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("deve retornar o próprio vetor com score ~1 quando query é o mesmo vetor", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    const emb = makeEmbedding();
    vr.upsert(makeMemory({ id: "target", embedding: emb }));

    // Adiciona mais alguns aleatórios
    for (let i = 0; i < 3; i++) {
      vr.upsert(makeMemory({ id: `noise-${i}`, embedding: makeEmbedding() }));
    }

    const results = vr.searchByVector(emb, 5);
    expect(results[0].id).toBe("target");
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  it("deve ordenar por score decrescente", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    for (let i = 0; i < 10; i++) {
      vr.upsert(makeMemory({ id: `m${i}`, embedding: makeEmbedding() }));
    }

    const results = vr.searchByVector(makeEmbedding(), 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("deve retornar todos se topK > size", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    for (let i = 0; i < 3; i++) {
      vr.upsert(makeMemory({ id: `m${i}`, embedding: makeEmbedding() }));
    }

    const results = vr.searchByVector(makeEmbedding(), 100);
    expect(results).toHaveLength(3);
  });
});

// ── memoryBytes ────────────────────────────────────────────────────────

describe("VectorRetriever.memoryBytes", () => {
  it("deve retornar 0 para índice vazio", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc, 384);
    expect(vr.memoryBytes).toBe(0);
  });

  it("deve calcular tamanho correto (N * dim * 4)", () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc, 384);

    vr.upsert(makeMemory({ id: "m1", embedding: makeEmbedding(384) }));
    vr.upsert(makeMemory({ id: "m2", embedding: makeEmbedding(384) }));

    expect(vr.memoryBytes).toBe(2 * 384 * 4); // 3072 bytes
  });
});

// ── search (async, com mock) ─────────────────────────────────────────

describe("VectorRetriever.search", () => {
  it("deve retornar array vazio se índice vazio", async () => {
    const embSvc = makeMockEmbeddingService();
    const vr = new VectorRetriever(embSvc);

    const results = await vr.search("any query", 10);
    expect(results).toHaveLength(0);
  });

  it("deve embedar query e buscar", async () => {
    const queryEmb = makeEmbedding(384);

    const embSvc = {
      embed: vi.fn().mockResolvedValue(queryEmb),
      embedBatch: vi.fn(),
      initialize: vi.fn(),
      isReady: true,
      activeBackend: "local" as const,
      error: null,
    } as unknown as EmbeddingService;

    const vr = new VectorRetriever(embSvc, 384);

    // Coloca uma memória alvo com o mesmo embedding da query
    vr.upsert(makeMemory({ id: "target", embedding: queryEmb }));
    // Adiciona ruído
    for (let i = 0; i < 3; i++) {
      vr.upsert(makeMemory({ id: `noise-${i}`, embedding: makeEmbedding(384) }));
    }

    const results = await vr.search("some query", 5);
    expect(results).toHaveLength(4);
    expect(results[0].id).toBe("target");
    expect(embSvc.embed).toHaveBeenCalledWith("some query");
  });
});

// ── searchAsResults ─────────────────────────────────────────────────

describe("VectorRetriever.searchAsResults", () => {
  it("deve resolver IDs para objetos Memory", async () => {
    const queryEmb = makeEmbedding(384);
    const mem = makeMemory({ id: "m1", text: "test memory 1", embedding: queryEmb });

    const embSvc = {
      embed: vi.fn().mockResolvedValue(queryEmb),
      embedBatch: vi.fn(),
      initialize: vi.fn(),
      isReady: true,
      activeBackend: "local" as const,
      error: null,
    } as unknown as EmbeddingService;

    const vr = new VectorRetriever(embSvc, 384);
    vr.upsert(mem);

    const lookup = vi.fn().mockReturnValue(mem);
    const results = await vr.searchAsResults("test", lookup, 10);

    expect(results).toHaveLength(1);
    expect(results[0].memory).toBe(mem);
    expect(results[0].strategy).toBe("vector");
    expect(lookup).toHaveBeenCalledWith("m1");
  });

  it("deve filtrar resultados cujo lookup retorna null", async () => {
    const queryEmb = makeEmbedding(384);

    const embSvc = {
      embed: vi.fn().mockResolvedValue(queryEmb),
      embedBatch: vi.fn(),
      initialize: vi.fn(),
      isReady: true,
      activeBackend: "local" as const,
      error: null,
    } as unknown as EmbeddingService;

    const vr = new VectorRetriever(embSvc, 384);
    vr.upsert(makeMemory({ id: "orphan", embedding: queryEmb }));

    const lookup = vi.fn().mockReturnValue(null); // memória não encontrada
    const results = await vr.searchAsResults("test", lookup, 10);

    expect(results).toHaveLength(0);
  });
});
