/**
 * HybridRetriever — Retrieval híbrido: BM25 + Vector.
 * ADR-005.
 *
 * Pipeline:
 *   1. Paralelo: BM25 (lexical) + Vector (semântico, se disponível)
 *   2. Merge: scores normalizados, dedup por id
 *   3. Retorna top-K final
 *
 * Graceful degradation:
 *   - Sem VectorRetriever → só BM25
 *   - Com tudo → BM25 + Vector
 */

import type { Memory, RetrievalResult } from "../types";
import type { IStorage } from "../storage/index";
import type { Bm25Retriever } from "./bm25";
import type { VectorRetriever } from "./vector";

// ── Config ─────────────────────────────────────────────────────────────

export interface HybridRetrieverConfig {
  /** Nº de resultados de cada estratégia antes da fusão. Default: 20 */
  candidatesPerStrategy: number;
  /** Ativar busca vetorial? Default: true (se disponível) */
  vectorEnabled: boolean;
}

const DEFAULTS: HybridRetrieverConfig = {
  candidatesPerStrategy: 20,
  vectorEnabled: true,
};

// ── HybridRetriever ────────────────────────────────────────────────────

export class HybridRetriever {
  private readonly bm25: Bm25Retriever;
  private readonly vector: VectorRetriever | null;
  private readonly storage: IStorage;
  private readonly projectId: string;
  private readonly config: HybridRetrieverConfig;

  constructor(
    bm25: Bm25Retriever,
    storage: IStorage,
    projectId: string,
    vector: VectorRetriever | null = null,
    config: Partial<HybridRetrieverConfig> = {}
  ) {
    this.bm25 = bm25;
    this.storage = storage;
    this.projectId = projectId;
    this.vector = vector;
    this.config = { ...DEFAULTS, ...config };
  }

  // ── Search ───────────────────────────────────────────────────────

  /**
   * Busca híbrida: BM25 + Vector (se disponível).
   * Score médio quando ambas estratégias retornam mesma memória.
   *
   * @param query - Texto de busca
   * @param topK - Número de resultados finais (default: 10)
   * @returns Resultados ranqueados com strategy indicando origem
   */
  async search(query: string, topK = 10): Promise<RetrievalResult[]> {
    const k = this.config.candidatesPerStrategy;

    // BM25 (síncrono)
    const bm25Results = this.bm25.search(query, this.projectId, k);

    // Vector (assíncrono, se disponível)
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

    // Merge: scores normalizados, dedup por id
    const merged = new Map<string, RetrievalResult>();
    for (const r of bm25Results) {
      merged.set(r.memory.id, r);
    }
    for (const r of vectorResults) {
      const existing = merged.get(r.memory.id);
      if (existing) {
        existing.score = (existing.score + r.score) / 2;
        existing.strategy = "hybrid";
      } else {
        merged.set(r.memory.id, r);
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ── Stats ────────────────────────────────────────────────────────

  /** Componentes ativos no pipeline */
  get activeComponents(): {
    bm25: boolean;
    vector: boolean;
  } {
    return {
      bm25: true,
      vector: this.vector !== null && this.config.vectorEnabled,
    };
  }
}
