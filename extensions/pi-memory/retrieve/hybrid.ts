/**
 * Reciprocal Rank Fusion (RRF) — ADR-005, Fase 2.5.
 *
 * Fusiona múltiplos result sets ranqueados em um único ranking combinado.
 * Não requer treinamento ou tuning — puramente algébrico.
 *
 * Fórmula: score_final = Σ 1/(k + rank_i) para cada estratégia i
 * onde k = 60 (constante de suavização), rank_i começa em 1.
 *
 * Referência: Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet
 * and individual rank learning methods", SIGIR 2009.
 */

import type { RetrievalResult } from "../types";

/**
 * Aplica RRF a múltiplos conjuntos de resultados ranqueados.
 *
 * Cada result set deve estar pré-ordenado (melhor primeiro).
 * Documentos que aparecem em múltiplos sets acumulam scores RRF.
 * Itens que só aparecem em um set recebem score apenas daquele set.
 *
 * @param resultSets - Arrays de RetrievalResult, cada um ranqueado (melhor → pior)
 * @param k - Constante de suavização (default: 60). Valores maiores reduzem
 *            o impacto de rankings muito altos de um único set.
 * @returns Resultados fusionados, ordenados por score RRF decrescente,
 *          com strategy="hybrid"
 */
export function reciprocalRankFusion(
  resultSets: RetrievalResult[][],
  k = 60
): RetrievalResult[] {
  if (resultSets.length === 0) return [];
  if (resultSets.length === 1) {
    // Single set: apenas normaliza scores (não tem com quem fusionar)
    return normalizeSingleSet(resultSets[0]);
  }

  // Mapa: memoryId → { memory, accumulatedScore }
  const scoreMap = new Map<
    string,
    { memory: RetrievalResult["memory"]; score: number }
  >();

  for (const results of resultSets) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      // rank = posição 1-indexed
      const rrfScore = 1 / (k + i + 1);

      const existing = scoreMap.get(r.memory.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(r.memory.id, {
          memory: r.memory,
          score: rrfScore,
        });
      }
    }
  }

  // Converte mapa para array, ordena por score decrescente
  const fused = [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map((item) => ({
      memory: item.memory,
      score: item.score,
      strategy: "hybrid" as const,
    }));

  return fused;
}

/**
 * Quando há apenas um result set, aplica normalização min-max
 * para manter scores no range 0-1 consistente.
 */
function normalizeSingleSet(results: RetrievalResult[]): RetrievalResult[] {
  if (results.length <= 1) {
    return results.map((r) => ({ ...r, strategy: "hybrid" as const }));
  }

  const scores = results.map((r) => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  return results.map((r) => ({
    memory: r.memory,
    score: range === 0 ? 0.5 : (r.score - minScore) / range,
    strategy: "hybrid" as const,
  }));
}
