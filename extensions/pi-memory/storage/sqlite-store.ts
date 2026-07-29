/**
 * SqliteStore — Camada warm de storage: SQLite + FTS5.
 *
 * Responsável por persistência primária das memórias e observações.
 * Usa adaptador cross-runtime: bun:sqlite (Bun) ou better-sqlite3 (Node).
 * FTS5 para busca full-text (BM25).
 */

import { createSqliteDb } from "./sqlite-factory";
import type { SqliteDatabase } from "./sqlite-adapter";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RawObservation, Page, PageType, PageScope, RetrievalResult } from "../types";
import type { IStorage } from "./index";

// ── SQL DDL ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
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
`;

// ── Pages DDL (novo modelo) ────────────────────────────────────────────

const SCHEMA_PAGES_SQL = `
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  tags TEXT,
  confidence REAL DEFAULT 0.5,
  status TEXT DEFAULT 'active',
  pinned INTEGER DEFAULT 0,
  supersedes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  UNIQUE(project_id, path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, body,
  content='pages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO pages_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS page_embeddings (
  page_id TEXT PRIMARY KEY REFERENCES pages(id),
  embedding BLOB,
  provider TEXT,
  model TEXT,
  dim INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project_id);
CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status);
`;

// ── SQL Statements (reusadas via db.query cache interno) ───────────────

const SQL = {
  deleteAllObservations: `DELETE FROM observations WHERE project_id = $project_id`,

  deleteAllPages: `DELETE FROM pages WHERE project_id = $project_id`,

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

  countObservations: `SELECT COUNT(*) as count FROM observations`,

  countPendingExtraction: `SELECT COUNT(*) as count FROM observations WHERE extracted = 0`,

  // ── Pages ────────────────────────────────────────────────────────────

  insertPage: `
    INSERT INTO pages (id, project_id, path, title, body, type, scope, tags,
      confidence, status, pinned, supersedes, created_at, updated_at, content_hash, mtime)
    VALUES ($id, $project_id, $path, $title, $body, $type, $scope, $tags,
      $confidence, $status, $pinned, $supersedes, $created_at, $updated_at, $content_hash, $mtime)
  `,

  updatePage: `
    UPDATE pages SET
      path = $path, title = $title, body = $body, type = $type, scope = $scope,
      tags = $tags, confidence = $confidence, status = $status, pinned = $pinned,
      supersedes = $supersedes, updated_at = $updated_at,
      content_hash = $content_hash, mtime = $mtime
    WHERE id = $id
  `,

  deletePage: `DELETE FROM pages WHERE project_id = $project_id AND path = $path`,

  getPage: `SELECT * FROM pages WHERE project_id = $project_id AND path = $path`,

  getPagesByProject: `SELECT * FROM pages WHERE project_id = $project_id ORDER BY updated_at DESC`,

  pageExists: `SELECT 1 FROM pages WHERE project_id = $project_id AND path = $path LIMIT 1`,

  pagesFtsSearch: `
    SELECT p.*, bm25(pages_fts) as fts_score
    FROM pages p
    JOIN pages_fts ON p.rowid = pages_fts.rowid
    WHERE pages_fts MATCH $query
      AND ($project_id IS NULL OR p.project_id = $project_id OR p.project_id = '_global')
    ORDER BY fts_score
    LIMIT $limit
  `,

  countPages: `SELECT COUNT(*) as count FROM pages WHERE status = 'active'`,

  getPagesWithEmbeddings: `SELECT p.* FROM pages p JOIN page_embeddings e ON p.id = e.page_id WHERE p.project_id = $project_id`,

  getPagesWithoutEmbedding: `SELECT p.* FROM pages p LEFT JOIN page_embeddings e ON p.id = e.page_id WHERE p.project_id = $project_id AND e.page_id IS NULL ORDER BY p.updated_at ASC`,

  updatePageEmbedding: `INSERT OR REPLACE INTO page_embeddings (page_id, embedding, provider, model, dim) VALUES ($page_id, $embedding, $provider, $model, $dim)`,
};

// ── Store ──────────────────────────────────────────────────────────────

export class SqliteStore implements IStorage {
  private db: SqliteDatabase;

  constructor(dbPath: string | ":memory:") {
    // Garante que o diretório pai existe (bun:sqlite não cria recursivamente)
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = createSqliteDb(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.db.exec(SCHEMA_PAGES_SQL);
  }

  deleteAllPages(projectId: string): number {
    const result = this.db.prepare(SQL.deleteAllPages).run({ $project_id: projectId });
    return result.changes;
  }

  deleteAllObservations(projectId: string): number {
    const result = this.db.prepare(SQL.deleteAllObservations).run({ $project_id: projectId });
    return result.changes;
  }

  // ── Pages ───────────────────────────────────────────────────────────

  insertPage(page: Page): void {
    this.db.prepare(SQL.insertPage).run({
      $id: page.id,
      $project_id: page.project_id,
      $path: page.path,
      $title: page.title,
      $body: page.body,
      $type: page.type,
      $scope: page.scope,
      $tags: JSON.stringify(page.tags),
      $confidence: page.confidence,
      $status: page.status,
      $pinned: page.pinned ? 1 : 0,
      $supersedes: page.supersedes ?? null,
      $created_at: page.created_at,
      $updated_at: page.updated_at,
      $content_hash: page.content_hash,
      $mtime: page.mtime,
    });
  }

  updatePage(page: Page): void {
    this.db.prepare(SQL.updatePage).run({
      $id: page.id,
      $path: page.path,
      $title: page.title,
      $body: page.body,
      $type: page.type,
      $scope: page.scope,
      $tags: JSON.stringify(page.tags),
      $confidence: page.confidence,
      $status: page.status,
      $pinned: page.pinned ? 1 : 0,
      $supersedes: page.supersedes ?? null,
      $updated_at: page.updated_at,
      $content_hash: page.content_hash,
      $mtime: page.mtime,
    });
  }

  deletePage(projectId: string, path: string): void {
    this.db.prepare(SQL.deletePage).run({ $project_id: projectId, $path: path });
  }

  getPage(projectId: string, path: string): Page | null {
    const row = this.db.prepare(SQL.getPage).get({
      $project_id: projectId,
      $path: path,
    }) as Record<string, unknown> | undefined;
    return row ? this.rowToPage(row) : null;
  }

  getPagesByProject(projectId: string): Page[] {
    const rows = this.db.prepare(SQL.getPagesByProject).all({
      $project_id: projectId,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToPage(r));
  }

  pageExists(projectId: string, path: string): boolean {
    const row = this.db.prepare(SQL.pageExists).get({
      $project_id: projectId,
      $path: path,
    }) as { 1?: number } | undefined;
    return !!row;
  }

  searchPagesFts(query: string, projectId: string | null, limit = 20): RetrievalResult[] {
    const ftsQuery = this.buildFtsQuery(query);
    const rows = this.db.prepare(SQL.pagesFtsSearch).all({
      $query: ftsQuery,
      $project_id: projectId ?? null,
      $limit: limit,
    }) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const page = this.rowToPage(r);
      const score = r["fts_score"] as number;
      return {
        page,
        snippet: page.body.slice(0, 300),
        score: this.normalizeScore(score, rows as Array<Record<string, unknown>>),
        strategy: "fts5" as const,
      };
    });
  }

  countPages(): number {
    const row = this.db.prepare(SQL.countPages).get() as { count: number };
    return row.count;
  }

  getPageById(id: string): Page | null {
    const row = this.db.prepare("SELECT * FROM pages WHERE id = $id").get({
      $id: id,
    }) as Record<string, unknown> | undefined;
    return row ? this.rowToPage(row) : null;
  }

  getPagesWithEmbeddingData(projectId: string): Array<{ id: string; embedding: Float32Array }> {
    const rows = this.db.prepare(`
      SELECT p.id, e.embedding
      FROM pages p
      JOIN page_embeddings e ON p.id = e.page_id
      WHERE p.project_id = $project_id
    `).all({ $project_id: projectId }) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const emb = r["embedding"] as Uint8Array | Buffer | ArrayBuffer;
      return {
        id: r["id"] as string,
        embedding: new Float32Array(
          emb instanceof ArrayBuffer ? emb : emb.buffer,
          emb instanceof ArrayBuffer ? 0 : emb.byteOffset,
          (emb instanceof ArrayBuffer ? emb.byteLength : emb.length) / 4
        ),
      };
    });
  }

  getPagesWithEmbeddings(projectId: string): Page[] {
    const rows = this.db.prepare(SQL.getPagesWithEmbeddings).all({
      $project_id: projectId,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToPage(r));
  }

  getPagesWithoutEmbedding(projectId: string): Page[] {
    const rows = this.db.prepare(SQL.getPagesWithoutEmbedding).all({
      $project_id: projectId,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToPage(r));
  }

  updatePageEmbedding(pageId: string, embedding: Float32Array): void {
    this.db.prepare(SQL.updatePageEmbedding).run({
      $page_id: pageId,
      $embedding: new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      $provider: "local",
      $model: "all-MiniLM-L6-v2",
      $dim: 384,
    });
  }

  // ── Observações ────────────────────────────────────────────────────

  insertObservation(obs: RawObservation): void {
    this.db.prepare(SQL.insertObservation).run({
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
    const insert = this.db.prepare(SQL.insertObservation);
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
    const rows = this.db.prepare(SQL.getObservations).all({
      $project_id: projectId,
      $limit: limit,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  getPendingObservations(projectId: string): RawObservation[] {
    const rows = this.db.prepare(SQL.getPendingObservations).all({
      $project_id: projectId,
    }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  markExtracted(observationIds: string[]): void {
    const update = this.db.prepare(SQL.markExtracted);
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        update.run({ $id: id });
      }
    });
    tx(observationIds);
  }

  cleanupExpired(now: number): number {
    const result = this.db.prepare(SQL.deleteExpiredObservations).run({
      $now: now,
    });
    return result.changes;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  countObservations(): number {
    const row = this.db.prepare(SQL.countObservations).get() as { count: number };
    return row.count;
  }

  countPendingExtraction(): number {
    const row = this.db.prepare(SQL.countPendingExtraction).get() as { count: number };
    return row.count;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  open(): void {
    // Construtor já abre o DB. Nada extra necessário.
  }

  close(): void {
    this.db.close();
  }

  // ── Serialization ──────────────────────────────────────────────────

  private rowToPage(row: Record<string, unknown>): Page {
    return {
      id: row["id"] as string,
      project_id: row["project_id"] as string,
      path: row["path"] as string,
      title: row["title"] as string,
      body: row["body"] as string,
      type: row["type"] as PageType,
      scope: row["scope"] as PageScope,
      tags: JSON.parse((row["tags"] as string) || "[]"),
      confidence: row["confidence"] as number,
      status: (row["status"] as Page["status"]) || "active",
      pinned: (row["pinned"] as number) === 1,
      supersedes: (row["supersedes"] as string) || null,
      created_at: row["created_at"] as number,
      updated_at: row["updated_at"] as number,
      content_hash: row["content_hash"] as string,
      mtime: row["mtime"] as number,
    };
  }

  /**
   * Normaliza score BM25 (menor = melhor) para score 0-1 (maior = melhor).
   * Usa min-max normalization sobre o batch retornado.
   */
  private normalizeScore(score: number, allRows: Array<Record<string, unknown>>, scoreKey = "fts_score"): number {
    if (allRows.length === 0) return 0;
    const scores = allRows.map((r) => r[scoreKey] as number);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    if (max === min) return 1.0;
    return 1.0 - (score - min) / (max - min);
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
    // Remove FTS5 special chars e pontuação comum
    const sanitized = query.replace(/["()+\-:^,.!?;:\[\]{}]/g, " ").trim();
    if (!sanitized) return '""';
    const words = sanitized.split(/\s+/).filter(Boolean);
    // Prefix match: cada termo casa tokens que começam com ele. OR para
    // qualquer termo bastar (AND implícito falha em prompts longos com stop words).
    return words.map((w) => {
      const clean = w.endsWith("*") ? w.slice(0, -1) : w;
      return `"${clean}"*`;
    }).join(" OR ");
  }
}
