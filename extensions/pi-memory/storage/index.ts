/**
 * IStorage — Interface do storage SQLite.
 * SQLite é o índice derivado do wiki markdown.
 * Todas as operações são síncronas.
 */

import type { RawObservation, Page, RetrievalResult } from "../types";

export interface IStorage {
  // ── Lifecycle ────────────────────────────────────────────────────
  open(): void;
  close(): void;

  // ── Observations ─────────────────────────────────────────────────
  insertObservation(obs: RawObservation): void;
  insertObservationsBatch(observations: RawObservation[]): void;
  getObservations(projectId: string, limit?: number): RawObservation[];
  getPendingObservations(projectId: string): RawObservation[];
  markExtracted(observationIds: string[]): void;
  cleanupExpired(now: number): number;

  // ── Pages (markdown como fonte da verdade) ───────────────────────
  insertPage(page: Page): void;
  updatePage(page: Page): void;
  deletePage(projectId: string, path: string): void;
  deleteAllPages(projectId: string): number;
  deleteAllObservations(projectId: string): number;
  searchTopPages(projectId: string, limit?: number): RetrievalResult[];
  getPage(projectId: string, path: string): Page | null;
  getPageById(id: string): Page | null;
  getPagesByProject(projectId: string): Page[];
  pageExists(projectId: string, path: string): boolean;
  searchPagesFts(query: string, projectId: string | null, limit?: number): RetrievalResult[];
  getPagesWithEmbeddings(projectId: string): Page[];
  getPagesWithEmbeddingData(projectId: string): Array<{ id: string; embedding: Float32Array }>;
  getPagesWithoutEmbedding(projectId: string): Page[];
  updatePageEmbedding(pageId: string, embedding: Float32Array): void;

  // ── Stats ────────────────────────────────────────────────────────
  countPages(): number;
  countObservations(): number;
  countPendingExtraction(): number;

}
