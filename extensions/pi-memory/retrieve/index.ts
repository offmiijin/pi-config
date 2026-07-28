/**
 * HybridRetriever — Retrieval híbrido: BM25 + Vector + RRF + Reranker.
 * ADR-005, Fase 2.5.
 *
 * Pipeline completo:
 *   1. Paralelo: BM25 (lexical) + Vector (semântico)
 *   2. RRF fusion: Reciprocal Rank Fusion (k=60)
 *   3. Reranker: Cross-encoder re-rankeia top-N fusionados
 *   4. Retorna top-K final
 *
 * Graceful degradation:
 *   - Sem VectorRetriever → só BM25 (sem RRF, sem reranker)
 *   - Sem RerankerService → BM25 + Vector → RRF (sem reranker)
 *   - Com tudo → pipeline completo
 */

import type { Memory, RetrievalResult } from "../types";
import type { IStorage } from "../storage/index";
import type { Bm25Retriever } from "./bm25";
import type { VectorRetriever } from "./vector";
import type { RerankerService } from "./reranker";
import { reciprocalRankFusion } from "./hybrid";

// ── Config ─────────────────────────────────────────────────────────────

export interface HybridRetrieverConfig {
  /** Nº de resultados de cada estratégia antes da fusão. Default: 20 */
  candidatesPerStrategy: number;
  /** Constante k do RRF. Default: 60 */
  rrfK: number;
  /** Nº de documentos a re-ranquear após RRF. Default: 20 */
  rerankTopN: number;
  /** Ativar busca vetorial? Default: true (se disponível) */
  vectorEnabled: boolean;
  /** Ativar reranker? Default: true (se disponível) */
  rerankerEnabled: boolean;
}

const DEFAULTS: HybridRetrieverConfig = {
  candidatesPerStrategy: 20,
  rrfK: 60,
  rerankTopN: 20,
  vectorEnabled: true,
  rerankerEnabled: true,
};

// ── HybridRetriever ────────────────────────────────────────────────────

export class HybridRetriever {
  private readonly bm25: Bm25Retriever;
  private readonly vector: VectorRetriever | null;
  private readonly reranker: RerankerService | null;
  private readonly storage: IStorage;
  private readonly projectId: string;
  private readonly config: HybridRetrieverConfig;

  constructor(
    bm25: Bm25Retriever,
    storage: IStorage,
    projectId: string,
    vector: VectorRetriever | null = null,
    reranker: RerankerService | null = null,
    config: Partial<HybridRetrieverConfig> = {}
  ) {
    this.bm25 = bm25;
    this.storage = storage;
    this.projectId = projectId;
    this.vector = vector;
    this.reranker = reranker;
    this.config = { ...DEFAULTS, ...config };
  }

  // ── Search ───────────────────────────────────────────────────────

  /**
   * Busca híbrida completa.
   *
   * @param query - Texto de busca
   * @param topK - Número de resultados finais (default: 10)
   * @returns Resultados ranqueados com strategy indicando origem
   */
  async search(query: string, topK = 10): Promise<RetrievalResult[]> {
    const k = this.config.candidatesPerStrategy;

    // ── Fase 1: Paralelo ──────────────────────────────────────────

    // BM25 é síncrono
    const bm25Results = this.bm25.search(query, this.projectId, k);

    // Vector é assíncrono (se disponível)
    let vectorResults: RetrievalResult[] = [];
    if (this.vector && this.config.vectorEnabled) {
      try {
        vectorResults = await this.vector.searchAsResults(
          query,
          (id) => this.storage.getMemory(id),
          k
        );
      } catch {
        // Vector search falhou, continua com BM25 apenas
      }
    }

    // ── Fase 2: RRF Fusion ────────────────────────────────────────

    const resultSets: RetrievalResult[][] = [bm25Results];
    if (vectorResults.length > 0) {
      resultSets.push(vectorResults);
    }

    let fused = reciprocalRankFusion(resultSets, this.config.rrfK);

    // ── Fase 3: Reranker ──────────────────────────────────────────

    if (
      this.reranker &&
      this.reranker.isReady &&
      this.config.rerankerEnabled &&
      fused.length > 0
    ) {
      try {
        const candidates = fused.slice(0, this.config.rerankTopN);

        const reranked = await this.reranker.rerank(
          query,
          candidates.map((r) => ({ id: r.memory.id, text: r.memory.text }))
        );

        // Mapeia scores do reranker de volta para RetrievalResult
        const rerankMap = new Map(reranked.map((r) => [r.id, r.score]));

        fused = candidates
          .map((r) => ({
            memory: r.memory,
            score: rerankMap.get(r.memory.id) ?? r.score,
            strategy: "hybrid" as const,
          }))
          .sort((a, b) => b.score - a.score);
      } catch {
        // Reranker falhou, mantém resultados RRF
      }
    }

    // ── Fase 4: Top-K ─────────────────────────────────────────────

    return fused.slice(0, topK);
  }

  /**
   * Busca síncrona (BM25-only fallback).
   * Usada por código que espera API síncrona (ex: testes).
   */
  searchSync(query: string, topK = 10): RetrievalResult[] {
    return this.bm25.search(query, this.projectId, topK);
  }

  // ── Stats ────────────────────────────────────────────────────────

  /** Componentes ativos no pipeline */
  get activeComponents(): {
    bm25: boolean;
    vector: boolean;
    reranker: boolean;
  } {
    return {
      bm25: true,
      vector: this.vector !== null && this.config.vectorEnabled,
      reranker:
        this.reranker !== null &&
        this.reranker.isReady &&
        this.config.rerankerEnabled,
    };
  }
}
