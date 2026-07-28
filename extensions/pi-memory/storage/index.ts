/**
 * IStorage — Interface unificada das camadas de storage.
 *
 * Abstrai as operações de warm (SQLite) e cold (JSON).
 * Todas as operações são síncronas.
 */

import type { Memory, RawObservation } from "../types";

export interface IStorage {
  // ── Lifecycle ────────────────────────────────────────────────────
  open(): void;
  close(): void;

  // ── Memories ─────────────────────────────────────────────────────
  insertMemory(memory: Memory): void;
  getMemory(id: string): Memory | null;
  getMemoriesByProject(projectId: string): Memory[];
  getMemoryByHash(projectId: string, contentHash: string): Memory | null;
  updateMemory(memory: Memory): void;
  deleteMemory(id: string): void;

  // ── Observations ─────────────────────────────────────────────────
  insertObservation(obs: RawObservation): void;
  insertObservationsBatch(observations: RawObservation[]): void;
  getObservations(projectId: string, limit?: number): RawObservation[];
  getPendingObservations(projectId: string): RawObservation[];
  markExtracted(observationIds: string[]): void;
  cleanupExpired(now: number): number;

  // ── Search ───────────────────────────────────────────────────────
  searchFts(
    query: string,
    projectId: string,
    limit?: number
  ): Array<{ memory: Memory; bm25Score: number }>;

  // ── Embeddings ───────────────────────────────────────────────────
  getMemoriesWithEmbeddings(projectId: string): Memory[];
  getMemoriesWithoutEmbedding(projectId: string): Memory[];
  updateEmbedding(id: string, embedding: Float32Array): void;

  // ── Stats ────────────────────────────────────────────────────────
  countMemories(): number;
  countObservations(): number;
  countPendingExtraction(): number;

  // ── Cold sync ────────────────────────────────────────────────────
  syncToJson(): void;
  loadFromJson(): Memory[];
}
