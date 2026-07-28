/**
 * UnifiedStore — Implementação de IStorage combinando SqliteStore (warm) + JsonStore (cold).
 *
 * SQLite é a fonte primária de verdade.
 * JSON é sincronizado sob demanda para backup/auditoria.
 *
 * Dual DB: project-scoped (project/session) no DB do projeto,
 *           global-scoped (user/global) no DB global compartilhado.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Memory, RawObservation, MemoryScope } from "../types";
import type { IStorage } from "./index";
import { SqliteStore } from "./sqlite-store";
import { JsonStore } from "./json-store";

/** Scopes que são armazenados no DB global (cross-project). */
const GLOBAL_SCOPES: Set<MemoryScope> = new Set(["user", "global"]);

export class UnifiedStore implements IStorage {
  private projectDb: SqliteStore;
  private globalDb: SqliteStore;
  private json: JsonStore;

  constructor(dbPath: string | ":memory:", dataDir: string) {
    // Garante que o diretório pai do DB existe antes de abrir
    if (dbPath !== ":memory:") {
      const dbDir = path.dirname(dbPath);
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.projectDb = new SqliteStore(dbPath);
    this.globalDb = new SqliteStore(
      dbPath === ":memory:"
        ? ":memory:"
        : path.join(path.dirname(dbPath), "global.db")
    );
    this.json = new JsonStore(dataDir);
  }

  // ── Helpers ────────────────────────────────────────────────────

  /** Determina qual DB usar baseado no scope da memória. */
  private dbFor(memoryOrScope: Memory | MemoryScope): SqliteStore {
    const scope = typeof memoryOrScope === "string" ? memoryOrScope : memoryOrScope.scope;
    return GLOBAL_SCOPES.has(scope) ? this.globalDb : this.projectDb;
  }

  /** Tenta buscar memória em ambos os DBs (project → global). */
  private getMemoryFromBoth(id: string): Memory | null {
    return this.projectDb.getMemory(id) ?? this.globalDb.getMemory(id);
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  open(): void {
    // SqliteStore já abre no constructor. Nada extra necessário.
  }

  close(): void {
    this.projectDb.close();
    this.globalDb.close();
  }

  // ── Memories ─────────────────────────────────────────────────────

  insertMemory(memory: Memory): void {
    this.dbFor(memory).insertMemory(memory);
  }

  getMemory(id: string): Memory | null {
    return this.getMemoryFromBoth(id);
  }

  getMemoriesByProject(projectId: string): Memory[] {
    const projectMemories = this.projectDb.getMemoriesByProject(projectId);
    const globalMemories = this.globalDb.getAllMemories();
    return [...projectMemories, ...globalMemories];
  }

  getMemoryByHash(projectId: string, contentHash: string): Memory | null {
    return (
      this.projectDb.getMemoryByHash(projectId, contentHash) ??
      this.globalDb.getMemoryByHashGlobal(contentHash)
    );
  }

  updateMemory(memory: Memory): void {
    this.dbFor(memory).updateMemory(memory);
  }

  deleteMemory(id: string): void {
    // Tenta em ambos (só um terá o registro)
    this.projectDb.deleteMemory(id);
    this.globalDb.deleteMemory(id);
  }

  deleteAllMemories(projectId: string): number {
    // Apenas memórias do projeto (preserva globais)
    return this.projectDb.deleteAllMemories(projectId);
  }

  deleteAllObservations(projectId: string): number {
    return this.projectDb.deleteAllObservations(projectId);
  }

  // ── Observations ─────────────────────────────────────────────────
  // Observações são sempre per-project (tool calls acontecem em um projeto específico).

  insertObservation(obs: RawObservation): void {
    this.projectDb.insertObservation(obs);
  }

  insertObservationsBatch(observations: RawObservation[]): void {
    this.projectDb.insertObservationsBatch(observations);
  }

  getObservations(projectId: string, limit = 100): RawObservation[] {
    return this.projectDb.getObservations(projectId, limit);
  }

  getPendingObservations(projectId: string): RawObservation[] {
    return this.projectDb.getPendingObservations(projectId);
  }

  markExtracted(observationIds: string[]): void {
    this.projectDb.markExtracted(observationIds);
  }

  cleanupExpired(now: number): number {
    return this.projectDb.cleanupExpired(now);
  }

  // ── Search ───────────────────────────────────────────────────────

  searchFts(
    query: string,
    projectId: string,
    limit = 20
  ): Array<{ memory: Memory; bm25Score: number }> {
    // Busca no project DB (project/session scoped) + global DB (user/global scoped)
    const projectResults = this.projectDb.searchFts(query, projectId, limit);
    const globalResults = this.globalDb.searchFtsAll(query, limit);

    // Merge e ordena por BM25 score (menor = melhor no BM25)
    const merged = [...projectResults, ...globalResults];
    merged.sort((a, b) => a.bm25Score - b.bm25Score);
    return merged.slice(0, limit);
  }

  // ── Embeddings ───────────────────────────────────────────────────

  getMemoriesWithEmbeddings(projectId: string): Memory[] {
    const projectMemories = this.projectDb.getMemoriesWithEmbeddings(projectId);
    const globalMemories = this.globalDb.getAllMemoriesWithEmbeddings();
    return [...projectMemories, ...globalMemories];
  }

  getMemoriesWithoutEmbedding(projectId: string): Memory[] {
    const projectMemories = this.projectDb.getMemoriesWithoutEmbedding(projectId);
    const globalMemories = this.globalDb.getAllMemoriesWithoutEmbedding();
    return [...projectMemories, ...globalMemories];
  }

  updateEmbedding(id: string, embedding: Float32Array): void {
    // Tenta project DB primeiro; se não encontrar, tenta global DB
    if (this.projectDb.getMemory(id)) {
      this.projectDb.updateEmbedding(id, embedding);
    } else {
      this.globalDb.updateEmbedding(id, embedding);
    }
  }

  // ── Stats ────────────────────────────────────────────────────────

  countMemories(): number {
    return this.projectDb.countMemories() + this.globalDb.countMemories();
  }

  countObservations(): number {
    return this.projectDb.countObservations();
  }

  countPendingExtraction(): number {
    return this.projectDb.countPendingExtraction();
  }

  // ── Cold sync ────────────────────────────────────────────────────

  syncToJson(): void {
    const projectMemories = this.projectDb.getAllMemories();
    const globalMemories = this.globalDb.getAllMemories();
    this.json.writeMemories([...projectMemories, ...globalMemories]);

    const observations = this.projectDb.getObservations("", 1_000_000);
    this.json.writeObservations(observations);
  }

  loadFromJson(): Memory[] {
    return this.json.readMemories();
  }
}
