/**
 * Testes do Reciprocal Rank Fusion (RRF).
 *
 * Cobre: fusão de 0, 1, 2+ result sets, constante k, ordenação.
 */

import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../retrieve/hybrid";
import type { Memory, RetrievalResult } from "../../types";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMem(id: string, text = "test"): Memory {
  return {
    id,
    text,
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
    content_hash: `hash-${id}`,
  };
}

function makeResult(id: string, score: number, strategy: "bm25" | "vector" = "bm25"): RetrievalResult {
  return { memory: makeMem(id), score, strategy };
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  it("deve retornar array vazio para input vazio", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it("deve retornar array vazio para sets vazios", () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("deve retornar resultados normalizados para um único set", () => {
    const results = [
      makeResult("a", 0.9),
      makeResult("b", 0.5),
    ];

    const fused = reciprocalRankFusion([results]);
    expect(fused).toHaveLength(2);
    // Todos devem ter strategy="hybrid"
    expect(fused.every((r) => r.strategy === "hybrid")).toBe(true);
  });

  it("deve fusionar dois sets com sobreposição parcial", () => {
    const bm25 = [
      makeResult("a", 0.9),
      makeResult("b", 0.5),
    ];
    const vector = [
      makeResult("b", 0.8),
      makeResult("c", 0.3),
    ];

    const fused = reciprocalRankFusion([bm25, vector]);
    expect(fused).toHaveLength(3); // a, b, c

    // 'b' aparece em ambos → deve ter score mais alto que 'a' ou 'c'
    const bScore = fused.find((r) => r.memory.id === "b")!.score;
    const aScore = fused.find((r) => r.memory.id === "a")!.score;
    const cScore = fused.find((r) => r.memory.id === "c")!.score;

    // RRF com k=60: b = 1/(60+2) + 1/(60+1) = 1/62 + 1/61 ≈ 0.01613 + 0.01639 = 0.03252
    // a = 1/(60+1) = 1/61 ≈ 0.01639
    // c = 1/(60+2) = 1/62 ≈ 0.01613
    expect(bScore).toBeGreaterThan(aScore);
    expect(bScore).toBeGreaterThan(cScore);
    // Ordenação: b > a > c
    expect(fused[0].memory.id).toBe("b");
    expect(fused[1].memory.id).toBe("a");
    expect(fused[2].memory.id).toBe("c");
  });

  it("deve ordenar por score RRF decrescente", () => {
    const bm25 = [
      makeResult("a", 1.0),
      makeResult("b", 0.9),
      makeResult("c", 0.8),
      makeResult("d", 0.7),
    ];
    const vector = [
      makeResult("d", 1.0),
      makeResult("c", 0.9),
      makeResult("b", 0.8),
      makeResult("a", 0.7),
    ];

    const fused = reciprocalRankFusion([bm25, vector]);

    // Todos aparecem em ambos → mesma soma RRF = mesmo score RRF
    // Mas ordenação por score decrescente (todos iguais → preserva ordem de inserção do Map)
    expect(fused).toHaveLength(4);
    // Todos com mesmo score RRF = 1/61 + 1/64 ≈ cada um tem score diferente
    // a: 1/(60+1) + 1/(60+4) = 1/61 + 1/64
    // b: 1/(60+2) + 1/(60+3) = 1/62 + 1/63
    // Pela simetria: a > b > c > d
    const scores = fused.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it("deve dar peso maior a rankings mais altos (posição 1 > posição 10)", () => {
    // Dois sets, cada um rankeia itens diferentes em posições diferentes
    const bm25 = Array.from({ length: 10 }, (_, i) =>
      makeResult(`bm25-${i}`, 1.0 - i * 0.1)
    );
    const vector = [
      makeResult("bm25-9", 1.0), // último no BM25, primeiro no vector
    ];

    const fused = reciprocalRankFusion([bm25, vector]);

    // bm25-9 aparece em 10ª posição no BM25 + 1ª no vector
    const idx = fused.findIndex((r) => r.memory.id === "bm25-9");
    // Deve estar entre os primeiros (vector rank 1 compensa BM25 rank 10)
    expect(idx).toBeLessThan(5);
  });

  it("deve funcionar com k personalizado", () => {
    // Set1: a em rank1, b em rank2
    // Set2: a em rank2, b em rank1
    // Com k menor, itens rankeados primeiro ganham mais peso relativo
    const set1 = [makeResult("winner", 1.0), makeResult("loser", 0.9)];
    const set2 = [makeResult("loser", 1.0), makeResult("winner", 0.9)];

    const fusedK60 = reciprocalRankFusion([set1, set2], 60);
    const fusedK10 = reciprocalRankFusion([set1, set2], 10);

    // Ambos têm mesma soma RRF (simétricos), scores idênticos
    // Mas podemos verificar que k afeta valor absoluto dos scores
    const maxScore60 = fusedK60[0].score;
    const maxScore10 = fusedK10[0].score;

    // k menor → scores RRF maiores (menor denominador)
    expect(maxScore10).toBeGreaterThan(maxScore60);
  });

  it("deve marcar strategy como 'hybrid' em todos os resultados", () => {
    const bm25 = [makeResult("a", 0.9)];
    const vector = [makeResult("b", 0.8)];

    const fused = reciprocalRankFusion([bm25, vector]);
    expect(fused.every((r) => r.strategy === "hybrid")).toBe(true);
  });

  it("deve lidar com 3+ result sets", () => {
    const set1 = [makeResult("a", 1.0), makeResult("b", 0.5)];
    const set2 = [makeResult("b", 0.9), makeResult("c", 0.3)];
    const set3 = [makeResult("c", 1.0), makeResult("a", 0.1)];

    const fused = reciprocalRankFusion([set1, set2, set3]);
    expect(fused).toHaveLength(3);

    // 'a': 1/(61) + 0 + 1/(62) = 1/61 + 1/62
    // 'b': 1/(62) + 1/(61) + 0 = 1/62 + 1/61
    // 'c': 0 + 1/(62) + 1/(61) = 1/62 + 1/61
    // Todos têm mesmo score RRF
    expect(fused[0].score).toBeCloseTo(fused[1].score, 3);
    expect(fused[1].score).toBeCloseTo(fused[2].score, 3);
  });

  it("não deve modificar os arrays de entrada", () => {
    const bm25 = [makeResult("a", 1.0)];
    const vector = [makeResult("b", 0.5)];

    const bm25Copy = [...bm25];
    const vectorCopy = [...vector];

    reciprocalRankFusion([bm25, vector]);

    expect(bm25).toEqual(bm25Copy);
    expect(vector).toEqual(vectorCopy);
  });
});
