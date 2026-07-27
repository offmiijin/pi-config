/**
 * UnifiedStore — Implementação de IStorage combinando SqliteStore (warm) + JsonStore (cold).
 *
 * SQLite é a fonte primária de verdade.
 * JSON é sincronizado sob demanda para backup/auditoria.
 */

import type { Memory, RawObservation } from "../types";
import type { IStorage } from "./index";
import { SqliteStore } from "./sqlite-store";
import { JsonStore } from "./json-store";

export class UnifiedStore implements IStorage {
  private sqlite: SqliteStore;
  private json: JsonStore;

  constructor(dbPath: string | ":memory:", dataDir: string) {
    this.sqlite = new SqliteStore(dbPath);
    this.json = new JsonStore(dataDir);
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  open(): void {
    // SqliteStore já abre no constructor. Nada extra necessário.
  }

  close(): void {
    this.sqlite.close();
  }

  // ── Memories ─────────────────────────────────────────────────────

  insertMemory(memory: Memory): void {
    this.sqlite.insertMemory(memory);
  }

  getMemory(id: string): Memory | null {
    return this.sqlite.getMemory(id);
  }

  getMemoriesByProject(projectId: string): Memory[] {
    return this.sqlite.getMemoriesByProject(projectId);
  }

  getMemoryByHash(projectId: string, contentHash: string): Memory | null {
    return this.sqlite.getMemoryByHash(projectId, contentHash);
  }

  updateMemory(memory: Memory): void {
    this.sqlite.updateMemory(memory);
  }

  deleteMemory(id: string): void {
    this.sqlite.deleteMemory(id);
  }

  // ── Observations ─────────────────────────────────────────────────

  insertObservation(obs: RawObservation): void {
    this.sqlite.insertObservation(obs);
  }

  insertObservationsBatch(observations: RawObservation[]): void {
    this.sqlite.insertObservationsBatch(observations);
  }

  getObservations(projectId: string, limit = 100): RawObservation[] {
    return this.sqlite.getObservations(projectId, limit);
  }

  getPendingObservations(projectId: string): RawObservation[] {
    return this.sqlite.getPendingObservations(projectId);
  }

  markExtracted(observationIds: string[]): void {
    this.sqlite.markExtracted(observationIds);
  }

  cleanupExpired(now: number): number {
    return this.sqlite.cleanupExpired(now);
  }

  // ── Search ───────────────────────────────────────────────────────

  searchFts(
    query: string,
    projectId: string,
    limit = 20
  ): Array<{ memory: Memory; bm25Score: number }> {
    return this.sqlite.searchFts(query, projectId, limit);
  }

  // ── Stats ────────────────────────────────────────────────────────

  countMemories(): number {
    return this.sqlite.countMemories();
  }

  countObservations(): number {
    return this.sqlite.countObservations();
  }

  countPendingExtraction(): number {
    return this.sqlite.countPendingExtraction();
  }

  // ── Cold sync ────────────────────────────────────────────────────

  syncToJson(): void {
    const memories = this.sqlite.getMemoriesByProject(""); // TODO: suporte multi-projeto
    this.json.writeMemories(memories);

    // Sync observations for each project? For now, just sync all.
    const observations = this.sqlite.getObservations("", 1_000_000);
    this.json.writeObservations(observations);
  }

  loadFromJson(): Memory[] {
    return this.json.readMemories();
  }
}
