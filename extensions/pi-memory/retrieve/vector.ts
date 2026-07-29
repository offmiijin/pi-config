/**
 * VectorRetriever — Busca semântica via similaridade de cosseno sobre páginas.
 *
 * Mantém índice em RAM com embeddings das páginas.
 * Usa brute-force dot product (IndexFlatIP equivalente).
 *
 * Para até 10K páginas com 384 dims, brute-force é <15ms.
 */

import type { Page, RetrievalResult } from "../types";
import type { EmbeddingService } from "../utils/embedding";
import { cosineSimilarity } from "../utils/embedding";

// ── VectorRetriever ──────────────────────────────────────────────────────

export class VectorRetriever {
  private vectors: Float32Array[] = [];
  private pageIds: string[] = [];
  private readonly embeddingService: EmbeddingService;
  private readonly dimension: number;

  constructor(embeddingService: EmbeddingService, dimension = 384) {
    this.embeddingService = embeddingService;
    this.dimension = dimension;
  }

  // ── Index management ────────────────────────────────────────────

  /**
   * Reconstrói índice completo a partir de uma lista de { id, embedding }.
   * Itens sem embedding são ignorados.
   * Ordem: pageIds[i] ↔ vectors[i].
   */
  buildIndex(items: Array<{ id: string; embedding: Float32Array }>): void {
    this.vectors = [];
    this.pageIds = [];

    for (const item of items) {
      if (item.embedding && item.embedding.length === this.dimension) {
        this.vectors.push(item.embedding);
        this.pageIds.push(item.id);
      }
    }
  }

  /** Adiciona ou atualiza uma página no índice (incremental, sem rebuild). */
  upsert(id: string, embedding: Float32Array): void {
    if (!embedding || embedding.length !== this.dimension) return;

    const idx = this.pageIds.indexOf(id);
    if (idx !== -1) {
      this.vectors[idx] = embedding;
    } else {
      this.vectors.push(embedding);
      this.pageIds.push(id);
    }
  }

  /** Remove uma página do índice. */
  remove(pageId: string): void {
    const idx = this.pageIds.indexOf(pageId);
    if (idx !== -1) {
      this.vectors.splice(idx, 1);
      this.pageIds.splice(idx, 1);
    }
  }

  /** Remove todos os vetores do índice */
  clear(): void {
    this.vectors = [];
    this.pageIds = [];
  }

  /** Número de vetores no índice */
  get size(): number {
    return this.vectors.length;
  }

  // ── Search ───────────────────────────────────────────────────────

  /**
   * Busca semântica: embed(query) → dot product → top-K.
   */
  async search(
    query: string,
    topK = 20
  ): Promise<Array<{ id: string; score: number }>> {
    if (this.vectors.length === 0) return [];

    const queryVec = await this.embeddingService.embed(query);
    return this.searchByVector(queryVec, topK);
  }

  /**
   * Busca por vetor já embeded.
   */
  searchByVector(
    queryVec: Float32Array,
    topK = 20
  ): Array<{ id: string; score: number }> {
    if (this.vectors.length === 0) return [];

    const scores = new Array<{ id: string; score: number }>(this.vectors.length);

    for (let i = 0; i < this.vectors.length; i++) {
      scores[i] = {
        id: this.pageIds[i],
        score: cosineSimilarity(queryVec, this.vectors[i]),
      };
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }

  /**
   * Busca e retorna resultados no formato RetrievalResult (compatível com BM25).
   *
   * @param query - Texto de busca
   * @param pageLookup - Função para resolver id → Page
   * @param topK - Número máximo de resultados
   */
  async searchAsResults(
    query: string,
    pageLookup: (id: string) => Page | null,
    topK = 20
  ): Promise<RetrievalResult[]> {
    const raw = await this.search(query, topK);

    return raw
      .map((r) => {
        const page = pageLookup(r.id);
        if (!page) return null;
        return {
          page,
          snippet: page.body.slice(0, 300),
          score: r.score,
          strategy: "vector" as const,
        } satisfies RetrievalResult;
      })
      .filter((r): r is RetrievalResult => r !== null);
  }

  // ── Stats ────────────────────────────────────────────────────────

  /** Memória estimada usada pelo índice (bytes) */
  get memoryBytes(): number {
    return this.vectors.length * this.dimension * 4; // Float32 = 4 bytes
  }
}
