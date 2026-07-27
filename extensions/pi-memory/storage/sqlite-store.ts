/**
 * SqliteStore — Camada warm de storage: SQLite + FTS5.
 *
 * Responsável por persistência primária das memórias e observações.
 * Usa bun:sqlite (nativo no Bun, sem dependências externas).
 * FTS5 para busca full-text (BM25).
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
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

// ── SQL Statements (reusadas via db.query cache interno) ───────────────

const SQL = {
  insertMemory: `
    INSERT INTO memories (id, text, embedding, type, scope, tags, confidence,
      timestamp, last_accessed, access_count, source_ids, superseded_by,
      pinned, project_id, content_hash)
    VALUES ($id, $text, $embedding, $type, $scope, $tags, $confidence,
      $timestamp, $last_accessed, $access_count, $source_ids, $superseded_by,
      $pinned, $project_id, $content_hash)
  `,

  getMemory: `SELECT * FROM memories WHERE id = $id`,

  getMemoriesByProject: `SELECT * FROM memories WHERE project_id = $project_id ORDER BY timestamp DESC`,

  getMemoryByHash: `SELECT * FROM memories WHERE project_id = $project_id AND content_hash = $content_hash`,

  updateMemory: `
    UPDATE memories SET
      text = $text, embedding = $embedding, type = $type, scope = $scope,
      tags = $tags, confidence = $confidence, timestamp = $timestamp,
      last_accessed = $last_accessed, access_count = $access_count,
      source_ids = $source_ids, superseded_by = $superseded_by,
      pinned = $pinned, project_id = $project_id, content_hash = $content_hash
    WHERE id = $id
  `,

  deleteMemory: `DELETE FROM memories WHERE id = $id`,

  insertObservation: `
    INSERT INTO observations (id, session_id, project_id, timestamp, type,
      tool_name, input_json, outcome, content_preview, error_preview,
      file_paths, ttl, extracted)
    VALUES ($id, $session_id, $project_id, $timestamp, $type,
      $tool_name, $input_json, $outcome, $content_preview, $error_preview,
      $file_paths, $ttl, $extracted)
  `,

  getObservations: `SELECT * FROM observations WHERE project_id = $project_id ORDER BY timestamp DESC LIMIT $limit`,

  getPendingObservations: `SELECT * FROM observations WHERE extracted = 0 AND project_id = $project_id ORDER BY timestamp ASC`,

  markExtracted: `UPDATE observations SET extracted = 1 WHERE id = $id`,

  deleteExpiredObservations: `DELETE FROM observations WHERE ttl < $now`,

  countMemories: `SELECT COUNT(*) as count FROM memories`,

  countObservations: `SELECT COUNT(*) as count FROM observations`,

  countPendingExtraction: `SELECT COUNT(*) as count FROM observations WHERE extracted = 0`,

  ftsSearch: `
    SELECT m.*, bm25(memories_fts) as bm25_score
    FROM memories m
    JOIN memories_fts ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH $query
      AND m.project_id = $project_id
    ORDER BY bm25_score
    LIMIT $limit
  `,
};

// ── Store ──────────────────────────────────────────────────────────────

export class SqliteStore {
  private db: Database;

  constructor(dbPath: string | ":memory:") {
    // Garante que o diretório pai existe (bun:sqlite não cria recursivamente)
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  // ── Memória ────────────────────────────────────────────────────────

  insertMemory(mem: Memory): void {
    this.db.query(SQL.insertMemory).run({
      $id: mem.id,
      $text: mem.text,
      $embedding: mem.embedding ? new Uint8Array(mem.embedding.buffer) : null,
      $type: mem.type,
      $scope: mem.scope,
      $tags: JSON.stringify(mem.tags),
      $confidence: mem.confidence,
      $timestamp: mem.timestamp,
      $last_accessed: mem.last_accessed,
      $access_count: mem.access_count,
      $source_ids: JSON.stringify(mem.source_ids),
      $superseded_by: mem.superseded_by,
      $pinned: mem.pinned ? 1 : 0,
      $project_id: mem.project_id,
      $content_hash: mem.content_hash,
    });
  }

  getMemory(id: string): Memory | null {
    const row = this.db.query(SQL.getMemory).get({ $id: id }) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  getMemoriesByProject(projectId: string): Memory[] {
    const rows = this.db.query(SQL.getMemoriesByProject).all({
      $project_id: projectId,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  getMemoryByHash(projectId: string, contentHash: string): Memory | null {
    const row = this.db.query(SQL.getMemoryByHash).get({
      $project_id: projectId,
      $content_hash: contentHash,
    }) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  updateMemory(mem: Memory): void {
    this.db.query(SQL.updateMemory).run({
      $id: mem.id,
      $text: mem.text,
      $embedding: mem.embedding ? new Uint8Array(mem.embedding.buffer) : null,
      $type: mem.type,
      $scope: mem.scope,
      $tags: JSON.stringify(mem.tags),
      $confidence: mem.confidence,
      $timestamp: mem.timestamp,
      $last_accessed: mem.last_accessed,
      $access_count: mem.access_count,
      $source_ids: JSON.stringify(mem.source_ids),
      $superseded_by: mem.superseded_by,
      $pinned: mem.pinned ? 1 : 0,
      $project_id: mem.project_id,
      $content_hash: mem.content_hash,
    });
  }

  deleteMemory(id: string): void {
    this.db.query(SQL.deleteMemory).run({ $id: id });
  }

  // ── Observações ────────────────────────────────────────────────────

  insertObservation(obs: RawObservation): void {
    this.db.query(SQL.insertObservation).run({
      $id: obs.id,
      $session_id: obs.session_id,
      $project_id: obs.project_id,
      $timestamp: obs.timestamp,
      $type: obs.type,
      $tool_name: obs.tool_name ?? null,
      $input_json: obs.input_json ?? null,
      $outcome: obs.outcome,
      $content_preview: obs.content_preview,
      $error_preview: obs.error_preview ?? null,
      $file_paths: JSON.stringify(obs.file_paths),
      $ttl: obs.ttl,
      $extracted: obs.extracted ? 1 : 0,
    });
  }

  insertObservationsBatch(observations: RawObservation[]): void {
    const insert = this.db.query(SQL.insertObservation);
    const tx = this.db.transaction((obs: RawObservation[]) => {
      for (const o of obs) {
        insert.run({
          $id: o.id,
          $session_id: o.session_id,
          $project_id: o.project_id,
          $timestamp: o.timestamp,
          $type: o.type,
          $tool_name: o.tool_name ?? null,
          $input_json: o.input_json ?? null,
          $outcome: o.outcome,
          $content_preview: o.content_preview,
          $error_preview: o.error_preview ?? null,
          $file_paths: JSON.stringify(o.file_paths),
          $ttl: o.ttl,
          $extracted: o.extracted ? 1 : 0,
        });
      }
    });
    tx(observations);
  }

  getObservations(projectId: string, limit = 100): RawObservation[] {
    const rows = this.db.query(SQL.getObservations).all({
      $project_id: projectId,
      $limit: limit,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  getPendingObservations(projectId: string): RawObservation[] {
    const rows = this.db.query(SQL.getPendingObservations).all({
      $project_id: projectId,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  markExtracted(observationIds: string[]): void {
    const update = this.db.query(SQL.markExtracted);
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        update.run({ $id: id });
      }
    });
    tx(observationIds);
  }

  cleanupExpired(now: number): number {
    const result = this.db.run(SQL.deleteExpiredObservations, {
      $now: now,
    });
    return result.changes;
  }

  // ── Search (FTS5 BM25) ─────────────────────────────────────────────

  searchFts(query: string, projectId: string, limit = 20): Array<{ memory: Memory; bm25Score: number }> {
    const ftsQuery = this.buildFtsQuery(query);
    const rows = this.db.query(SQL.ftsSearch).all({
      $query: ftsQuery,
      $project_id: projectId,
      $limit: limit,
    }) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      memory: this.rowToMemory(r),
      bm25Score: r["bm25_score"] as number,
    }));
  }

  // ── Stats ──────────────────────────────────────────────────────────

  countMemories(): number {
    const row = this.db.query(SQL.countMemories).get() as { count: number };
    return row.count;
  }

  countObservations(): number {
    const row = this.db.query(SQL.countObservations).get() as { count: number };
    return row.count;
  }

  countPendingExtraction(): number {
    const row = this.db.query(SQL.countPendingExtraction).get() as { count: number };
    return row.count;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Serialization ──────────────────────────────────────────────────

  private rowToMemory(row: Record<string, unknown>): Memory {
    const emb = row["embedding"] as Uint8Array | Buffer | ArrayBuffer | null;
    return {
      id: row["id"] as string,
      text: row["text"] as string,
      embedding: emb
        ? new Float32Array(
            emb instanceof ArrayBuffer ? emb : emb.buffer,
            emb instanceof ArrayBuffer ? 0 : emb.byteOffset,
            (emb instanceof ArrayBuffer ? emb.byteLength : emb.length) / 4
          )
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
    const sanitized = query.replace(/["*()+\-:^]/g, " ").trim();
    if (!sanitized) return '""';
    const words = sanitized.split(/\s+/).filter(Boolean);
    return words.map((w) => `"${w}"`).join(" ");
  }
}
