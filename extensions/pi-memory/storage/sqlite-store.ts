/**
 * SqliteStore — Camada warm de storage: SQLite + FTS5.
 *
 * Responsável por persistência primária das memórias e observações.
 * Usa better-sqlite3 (síncrono, sem dependência nativa complexa).
 * FTS5 para busca full-text (BM25).
 */

import Database from "better-sqlite3";
import type { Memory, MemoryType, MemoryScope, RawObservation } from "../types";

// ── SQL DDL ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  embedding BLOB,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  tags TEXT,
  confidence REAL DEFAULT 0.5,
  timestamp INTEGER NOT NULL,
  last_accessed INTEGER,
  access_count INTEGER DEFAULT 0,
  source_ids TEXT,
  superseded_by TEXT,
  pinned INTEGER DEFAULT 0,
  project_id TEXT NOT NULL,
  content_hash TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  type,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, type, tags)
  VALUES (new.rowid, new.text, new.type, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, type, tags)
  VALUES ('delete', old.rowid, old.text, old.type, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, type, tags)
  VALUES ('delete', old.rowid, old.text, old.type, old.tags);
  INSERT INTO memories_fts(rowid, text, type, tags)
  VALUES (new.rowid, new.text, new.type, new.tags);
END;

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  outcome TEXT NOT NULL,
  content_preview TEXT,
  error_preview TEXT,
  file_paths TEXT,
  ttl INTEGER NOT NULL,
  extracted INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_observations_ttl ON observations(ttl);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
`;

// ── Prepared Statements ────────────────────────────────────────────────
// Guardados como propriedades para reuso e performance.

export class SqliteStore {
  private db: Database.Database;
  private stmts: {
    insertMemory: Database.Statement;
    getMemory: Database.Statement;
    getMemoriesByProject: Database.Statement;
    getMemoryByHash: Database.Statement;
    updateMemory: Database.Statement;
    deleteMemory: Database.Statement;
    insertObservation: Database.Statement;
    getObservations: Database.Statement;
    getPendingObservations: Database.Statement;
    markExtracted: Database.Statement;
    deleteExpiredObservations: Database.Statement;
    countMemories: Database.Statement;
    countObservations: Database.Statement;
    countPendingExtraction: Database.Statement;
    ftsSearch: Database.Statement;
  };

  constructor(dbPath: string | ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      insertMemory: this.db.prepare(`
        INSERT INTO memories (id, text, embedding, type, scope, tags, confidence,
          timestamp, last_accessed, access_count, source_ids, superseded_by,
          pinned, project_id, content_hash)
        VALUES (@id, @text, @embedding, @type, @scope, @tags, @confidence,
          @timestamp, @last_accessed, @access_count, @source_ids, @superseded_by,
          @pinned, @project_id, @content_hash)
      `),

      getMemory: this.db.prepare(`SELECT * FROM memories WHERE id = ?`),

      getMemoriesByProject: this.db.prepare(
        `SELECT * FROM memories WHERE project_id = ? ORDER BY timestamp DESC`
      ),

      getMemoryByHash: this.db.prepare(
        `SELECT * FROM memories WHERE project_id = ? AND content_hash = ?`
      ),

      updateMemory: this.db.prepare(`
        UPDATE memories SET
          text = @text, embedding = @embedding, type = @type, scope = @scope,
          tags = @tags, confidence = @confidence, timestamp = @timestamp,
          last_accessed = @last_accessed, access_count = @access_count,
          source_ids = @source_ids, superseded_by = @superseded_by,
          pinned = @pinned, project_id = @project_id, content_hash = @content_hash
        WHERE id = @id
      `),

      deleteMemory: this.db.prepare(`DELETE FROM memories WHERE id = ?`),

      insertObservation: this.db.prepare(`
        INSERT INTO observations (id, session_id, project_id, timestamp, type,
          tool_name, input_json, outcome, content_preview, error_preview,
          file_paths, ttl, extracted)
        VALUES (@id, @session_id, @project_id, @timestamp, @type,
          @tool_name, @input_json, @outcome, @content_preview, @error_preview,
          @file_paths, @ttl, @extracted)
      `),

      getObservations: this.db.prepare(
        `SELECT * FROM observations WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?`
      ),

      getPendingObservations: this.db.prepare(
        `SELECT * FROM observations WHERE extracted = 0 AND project_id = ? ORDER BY timestamp ASC`
      ),

      markExtracted: this.db.prepare(
        `UPDATE observations SET extracted = 1 WHERE id = ?`
      ),

      deleteExpiredObservations: this.db.prepare(
        `DELETE FROM observations WHERE ttl < ?`
      ),

      countMemories: this.db.prepare(`SELECT COUNT(*) as count FROM memories`),

      countObservations: this.db.prepare(`SELECT COUNT(*) as count FROM observations`),

      countPendingExtraction: this.db.prepare(
        `SELECT COUNT(*) as count FROM observations WHERE extracted = 0`
      ),

      ftsSearch: this.db.prepare(`
        SELECT m.*, bm25(memories_fts) as bm25_score
        FROM memories m
        JOIN memories_fts ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH @query
          AND m.project_id = @project_id
        ORDER BY bm25_score
        LIMIT @limit
      `),
    };
  }

  // ── Memória ────────────────────────────────────────────────────────

  insertMemory(mem: Memory): void {
    this.stmts.insertMemory.run({
      ...mem,
      embedding: mem.embedding ? Buffer.from(mem.embedding.buffer) : null,
      tags: JSON.stringify(mem.tags),
      source_ids: JSON.stringify(mem.source_ids),
      pinned: mem.pinned ? 1 : 0,
    });
  }

  getMemory(id: string): Memory | null {
    const row = this.stmts.getMemory.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  getMemoriesByProject(projectId: string): Memory[] {
    const rows = this.stmts.getMemoriesByProject.all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  getMemoryByHash(projectId: string, contentHash: string): Memory | null {
    const row = this.stmts.getMemoryByHash.get(projectId, contentHash) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  updateMemory(mem: Memory): void {
    this.stmts.updateMemory.run({
      ...mem,
      embedding: mem.embedding ? Buffer.from(mem.embedding.buffer) : null,
      tags: JSON.stringify(mem.tags),
      source_ids: JSON.stringify(mem.source_ids),
      pinned: mem.pinned ? 1 : 0,
    });
  }

  deleteMemory(id: string): void {
    this.stmts.deleteMemory.run(id);
  }

  // ── Observações ────────────────────────────────────────────────────

  insertObservation(obs: RawObservation): void {
    this.stmts.insertObservation.run({
      ...obs,
      input_json: obs.input_json ?? null,
      tool_name: obs.tool_name ?? null,
      error_preview: obs.error_preview ?? null,
      file_paths: JSON.stringify(obs.file_paths),
      extracted: obs.extracted ? 1 : 0,
    });
  }

  insertObservationsBatch(observations: RawObservation[]): void {
    const insert = this.stmts.insertObservation;
    const tx = this.db.transaction((obs: RawObservation[]) => {
      for (const o of obs) {
        insert.run({
          ...o,
          input_json: o.input_json ?? null,
          tool_name: o.tool_name ?? null,
          error_preview: o.error_preview ?? null,
          file_paths: JSON.stringify(o.file_paths),
          extracted: o.extracted ? 1 : 0,
        });
      }
    });
    tx(observations);
  }

  getObservations(projectId: string, limit = 100): RawObservation[] {
    const rows = this.stmts.getObservations.all(projectId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  getPendingObservations(projectId: string): RawObservation[] {
    const rows = this.stmts.getPendingObservations.all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  markExtracted(observationIds: string[]): void {
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmts.markExtracted.run(id);
      }
    });
    tx(observationIds);
  }

  cleanupExpired(now: number): number {
    const result = this.stmts.deleteExpiredObservations.run(now);
    return result.changes;
  }

  // ── Search (FTS5 BM25) ─────────────────────────────────────────────

  searchFts(query: string, projectId: string, limit = 20): Array<{ memory: Memory; bm25Score: number }> {
    // FTS5 MATCH syntax requires proper escaping
    const ftsQuery = this.buildFtsQuery(query);
    const rows = this.stmts.ftsSearch.all({
      query: ftsQuery,
      project_id: projectId,
      limit,
    }) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      memory: this.rowToMemory(r),
      bm25Score: r["bm25_score"] as number,
    }));
  }

  // ── Stats ──────────────────────────────────────────────────────────

  countMemories(): number {
    const row = this.stmts.countMemories.get() as { count: number };
    return row.count;
  }

  countObservations(): number {
    const row = this.stmts.countObservations.get() as { count: number };
    return row.count;
  }

  countPendingExtraction(): number {
    const row = this.stmts.countPendingExtraction.get() as { count: number };
    return row.count;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Serialization ──────────────────────────────────────────────────

  private rowToMemory(row: Record<string, unknown>): Memory {
    const embeddingBytes = row["embedding"] as Buffer | null;
    return {
      id: row["id"] as string,
      text: row["text"] as string,
      embedding: embeddingBytes
        ? new Float32Array(embeddingBytes.buffer, embeddingBytes.byteOffset, embeddingBytes.length / 4)
        : null,
      type: row["type"] as MemoryType,
      scope: row["scope"] as MemoryScope,
      tags: JSON.parse((row["tags"] as string) || "[]"),
      confidence: row["confidence"] as number,
      timestamp: row["timestamp"] as number,
      last_accessed: row["last_accessed"] as number,
      access_count: row["access_count"] as number,
      source_ids: JSON.parse((row["source_ids"] as string) || "[]"),
      superseded_by: (row["superseded_by"] as string) || null,
      pinned: (row["pinned"] as number) === 1,
      project_id: row["project_id"] as string,
      content_hash: row["content_hash"] as string,
    };
  }

  private rowToObservation(row: Record<string, unknown>): RawObservation {
    return {
      id: row["id"] as string,
      session_id: row["session_id"] as string,
      project_id: row["project_id"] as string,
      timestamp: row["timestamp"] as number,
      type: row["type"] as RawObservation["type"],
      tool_name: (row["tool_name"] as string) || null,
      input_json: (row["input_json"] as string) || null,
      outcome: row["outcome"] as "success" | "error",
      content_preview: row["content_preview"] as string,
      error_preview: (row["error_preview"] as string) || null,
      file_paths: JSON.parse((row["file_paths"] as string) || "[]"),
      ttl: row["ttl"] as number,
      extracted: (row["extracted"] as number) === 1,
    };
  }

  // ── FTS5 query builder ─────────────────────────────────────────────

  private buildFtsQuery(query: string): string {
    // Escape FTS5 special characters and build a simple AND query
    // FTS5 special chars: * " ( ) + - : ^
    const sanitized = query.replace(/["*()+\-:^]/g, " ").trim();
    if (!sanitized) return '""';
    // Quote each word for exact matching
    const words = sanitized.split(/\s+/).filter(Boolean);
    return words.map((w) => `"${w}"`).join(" ");
  }
}
