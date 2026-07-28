/**
 * VectorRetriever — Busca semântica via similaridade de cosseno.
 *
 * Mantém índice em RAM com todos os embeddings do projeto.
 * Usa brute-force dot product (IndexFlatIP equivalente).
 *
 * ADR-005: Vector search via faiss, mas implementado como dot product
 * puro para evitar dependência nativa (faiss-node). Para até 10K memórias
 * com 384 dims, brute-force é <15ms — dentro da latência alvo.
 *
 * ADR-003: Hot path — índice em RAM, reconstruído no session_start.
 */

import type { Memory, RetrievalResult } from "../types";
import type { EmbeddingService } from "../utils/embedding";
import { cosineSimilarity } from "../utils/embedding";

// ── VectorRetriever ──────────────────────────────────────────────────────

export class VectorRetriever {
  private vectors: Float32Array[] = [];
  private memoryIds: string[] = [];
  private readonly embeddingService: EmbeddingService;
  private readonly dimension: number;

  constructor(embeddingService: EmbeddingService, dimension = 384) {
    this.embeddingService = embeddingService;
    this.dimension = dimension;
  }

  // ── Index management ────────────────────────────────────────────

  /**
   * Reconstrói índice completo a partir de uma lista de memórias.
   * Memórias SEM embedding são ignoradas.
   * Ordem: memoryIds[i] ↔ vectors[i].
   */
  buildIndex(memories: Memory[]): void {
    this.vectors = [];
    this.memoryIds = [];

    for (const mem of memories) {
      if (mem.embedding && mem.embedding.length === this.dimension) {
        this.vectors.push(mem.embedding);
        this.memoryIds.push(mem.id);
      }
    }
  }

  /** Adiciona ou atualiza uma memória no índice (incremental, sem rebuild). */
  upsert(memory: Memory): void {
    if (!memory.embedding || memory.embedding.length !== this.dimension) return;

    const idx = this.memoryIds.indexOf(memory.id);
    if (idx !== -1) {
      this.vectors[idx] = memory.embedding;
    } else {
      this.vectors.push(memory.embedding);
      this.memoryIds.push(memory.id);
    }
  }

  /** Remove uma memória do índice. */
  remove(memoryId: string): void {
    const idx = this.memoryIds.indexOf(memoryId);
    if (idx !== -1) {
      this.vectors.splice(idx, 1);
      this.memoryIds.splice(idx, 1);
    }
  }

  /** Número de vetores no índice */
  get size(): number {
    return this.vectors.length;
  }

  // ── Search ───────────────────────────────────────────────────────

  /**
   * Busca semântica: embed(query) → dot product → top-K.
   *
   * @param query - Texto de busca (será embeded)
   * @param topK - Número máximo de resultados
   * @returns Memory IDs com scores, ordenados por relevância
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
   * Busca por vetor já embeded (ex: para queries pré-computadas).
   */
  searchByVector(
    queryVec: Float32Array,
    topK = 20
  ): Array<{ id: string; score: number }> {
    if (this.vectors.length === 0) return [];

    const scores = new Array<{ id: string; score: number }>(this.vectors.length);

    for (let i = 0; i < this.vectors.length; i++) {
      scores[i] = {
        id: this.memoryIds[i],
        score: cosineSimilarity(queryVec, this.vectors[i]),
      };
    }

    // Sort descending by score
    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK);
  }

  /**
   * Busca e retorna resultados no formato RetrievalResult (compatível com BM25).
   * Precisa de acesso ao storage para resolver Memory objects.
   *
   * @param query - Texto de busca
   * @param memoryLookup - Função para resolver id → Memory
   * @param topK - Número máximo de resultados
   */
  async searchAsResults(
    query: string,
    memoryLookup: (id: string) => Memory | null,
    topK = 20
  ): Promise<RetrievalResult[]> {
    const raw = await this.search(query, topK);

    return raw
      .map((r) => {
        const mem = memoryLookup(r.id);
        if (!mem) return null;
        return {
          memory: mem,
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
