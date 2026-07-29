/**
 * IStorage — Interface do storage SQLite.
 * SQLite é o índice derivado do wiki markdown.
 * Todas as operações são síncronas.
 */

import type { Memory, RawObservation, Page, PageSearchResult } from "../types";

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
  deleteAllMemories(projectId: string): number;
  deleteAllObservations(projectId: string): number;

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

  // ── Pages (novo modelo — markdown como fonte) ────────────────────
  insertPage(page: Page): void;
  updatePage(page: Page): void;
  deletePage(projectId: string, path: string): void;
  getPage(projectId: string, path: string): Page | null;
  getPagesByProject(projectId: string): Page[];
  pageExists(projectId: string, path: string): boolean;
  searchPagesFts(query: string, projectId: string | null, limit?: number): PageSearchResult[];
  getPagesWithEmbeddings(projectId: string): Page[];
  getPagesWithoutEmbedding(projectId: string): Page[];
  updatePageEmbedding(pageId: string, embedding: Float32Array): void;
  countPages(): number;

  // ── Stats ────────────────────────────────────────────────────────
  countMemories(): number;
  countObservations(): number;
  countPendingExtraction(): number;
  countPages(): number;

}
