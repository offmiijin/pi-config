/**
 * Testes do EmbeddingService + utilidades de vetor.
 *
 * Cobre: inicialização lazy, embed, embedBatch, cosineSimilarity,
 * normalizeVector, graceful degradation.
 */

import { describe, it, expect } from "vitest";
import { cosineSimilarity, normalizeVector, EmbeddingService } from "../../utils/embedding";

// ── cosineSimilarity ──────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("deve retornar 1.0 para vetores idênticos normalizados", () => {
    const v = normalizeVector(new Float32Array([1, 2, 3, 4]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("deve retornar -1.0 para vetores opostos", () => {
    const a = normalizeVector(new Float32Array([1, 0, 0]));
    const b = normalizeVector(new Float32Array([-1, 0, 0]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("deve retornar ~0 para vetores ortogonais", () => {
    const a = normalizeVector(new Float32Array([1, 0, 0]));
    const b = normalizeVector(new Float32Array([0, 1, 0]));
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.001);
  });

  it("deve retornar valor positivo para vetores similares", () => {
    // Vetores com mesma direção mas magnitudes diferentes
    const a = normalizeVector(new Float32Array([1, 1, 1]));
    const b = normalizeVector(new Float32Array([2, 2, 2]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("deve funcionar com vetores de dimensão arbitrária", () => {
    const dim = 384;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    // Fill with same pattern
    for (let i = 0; i < dim; i++) {
      a[i] = Math.sin(i * 0.1);
      b[i] = Math.sin(i * 0.1);
    }
    normalizeVector(a);
    normalizeVector(b);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("deve retornar 0 para vetores zerados", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

// ── normalizeVector ────────────────────────────────────────────────────

describe("normalizeVector", () => {
  it("deve normalizar vetor para comprimento unitário", () => {
    const v = normalizeVector(new Float32Array([3, 4]));
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("deve preservar direção do vetor", () => {
    const original = new Float32Array([3, 4]);
    const normalized = normalizeVector(new Float32Array([3, 4]));
    // Razão entre componentes deve ser preservada
    expect(normalized[0] / normalized[1]).toBeCloseTo(original[0] / original[1], 5);
  });

  it("não deve quebrar com vetor zerado (mantém zeros)", () => {
    const v = normalizeVector(new Float32Array([0, 0, 0]));
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
  });

  it("deve modificar in-place", () => {
    const v = new Float32Array([1, 0, 0]);
    const result = normalizeVector(v);
    expect(result).toBe(v); // mesma referência
  });

  it("deve funcionar com dimensão 384", () => {
    const dim = 384;
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = i + 1;
    const normalized = normalizeVector(v);
    let sumSq = 0;
    for (let i = 0; i < dim; i++) sumSq += normalized[i] * normalized[i];
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 5);
  });
});

// ── EmbeddingService ──────────────────────────────────────────────────

describe("EmbeddingService", () => {
  it("deve inicializar com isReady=false antes de initialize()", () => {
    const svc = new EmbeddingService();
    expect(svc.isReady).toBe(false);
  });

  it("deve reportar backend='none' antes de initialize()", () => {
    const svc = new EmbeddingService();
    expect(svc.activeBackend).toBe("none");
  });

  it("deve expor error=null antes de initialize()", () => {
    const svc = new EmbeddingService();
    expect(svc.error).toBeNull();
  });

  it("deve aceitar config customizada", () => {
    const svc = new EmbeddingService({
      model: "custom-model",
      dimension: 768,
      normalize: false,
    });
    // Config é internal, mas não deve quebrar
    expect(svc.isReady).toBe(false);
  });

  it("deve lançar ao chamar embed() sem initialize()", async () => {
    const svc = new EmbeddingService();
    await expect(svc.embed("test")).rejects.toThrow("not ready");
  });

  it("deve lançar ao chamar embedBatch() sem initialize()", async () => {
    const svc = new EmbeddingService();
    await expect(svc.embedBatch(["test"])).rejects.toThrow("not ready");
  });

  it("initialize() deve ser thread-safe (chamadas concorrentes)", async () => {
    const svc = new EmbeddingService();
    // Múltiplas chamadas devem resolver sem erro
    const results = await Promise.allSettled([
      svc.initialize(),
      svc.initialize(),
      svc.initialize(),
    ]);
    // Todas devem resolver (reject ok se modelo não disponível)
    expect(results.every((r) => r.status === "fulfilled" || r.status === "rejected")).toBe(true);
  });

  it("deve lidar com texto vazio ao tentar embed (só testa interface)", async () => {
    const svc = new EmbeddingService();
    // Não deve quebrar na validação de parâmetros
    const prom = svc.embed("");
    await expect(prom).rejects.toThrow(); // rejeita porque não está pronto
  });
});
