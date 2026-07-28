# STORAGE — Detalhes de Implementação

## Objetivo

Persistir memórias semânticas e observações brutas em 3 camadas com tradeoffs diferentes de latência, complexidade e portabilidade.

## Arquitetura de 3 Camadas

```
┌───────────────────────────────────────────────┐
│ HOT:  RamIndex (memória RAM)                   │
│        - BM25 index (custom)                   │
│        - Faiss vector index (384 dims)         │
│        - Reconstruído no session_start          │
│        - Latência: 1-50ms                      │
│        - Volátil (perdido no restart)          │
├───────────────────────────────────────────────┤
│ WARM: SqliteStore (disco)                      │
│        - SQLite + FTS5 + better-sqlite3        │
│        - Persiste entre sessões                │
│        - Latência: 10-200ms                    │
│        - Schema relacional + full-text index   │
├───────────────────────────────────────────────┤
│ COLD: JsonStore (disco)                        │
│        - JSON em ~/.pi/agent/memory/data/      │
│        - Legível, editável, git versionável    │
│        - Latência: 100ms-2s                    │
│        - Usado para auditoria, debug, rebuild  │
└───────────────────────────────────────────────┘
```

## Interface IStorage

```typescript
interface IStorage {
  // ── Memories ──
  insertMemory(memory: Memory): Promise<void>;
  updateMemory(id: string, updates: Partial<Memory>): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  getMemory(id: string): Promise<Memory | null>;
  getMemoriesByProject(projectId: string, options?: {
    type?: MemoryType;
    scope?: MemoryScope;
    limit?: number;
    offset?: number;
  }): Promise<Memory[]>;
  getAllMemories(options?: { limit?: number }): Promise<Memory[]>;
  getMemoryCount(projectId: string): Promise<number>;

  // ── Observations ──
  insertObservation(obs: RawObservation): Promise<void>;
  insertObservations(obs: RawObservation[]): Promise<void>;
  updateObservation(id: string, updates: Partial<RawObservation>): Promise<void>;
  getObservation(id: string): Promise<RawObservation | null>;
  getUnextractedObservations(projectId: string, limit?: number): Promise<RawObservation[]>;
  getObservationsBySession(sessionId: string): Promise<RawObservation[]>;
  deleteExpiredObservations(): Promise<number>; // retorna count de deletadas

  // ── Lifecycle ──
  open(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;

  // ── FTS5 ──
  searchFts5(query: string, projectId: string, limit?: number): Promise<ScoredMemory[]>;
}
```

## Warm Layer: SqliteStore

### Dependência

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  }
}
```

`better-sqlite3` é síncrono por padrão. Todas as operações de storage são synchronous para simplicidade. Camada de serviço (acima) wrappa em async para compatibilidade com o resto do sistema.

### Localização do DB

```
~/.pi/agent/memory/data/memory.db
```

Criado automaticamente se não existir. Path configurável via `PI_MEMORY_DB_PATH`.

### Schema DDL

```sql
-- Executado em open() se DB não existe

CREATE TABLE IF NOT EXISTS memories (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,            -- float32, 384 dims (1536 bytes)
  type TEXT NOT NULL CHECK(type IN ('preference','decision','lesson','fact','pattern')),
  scope TEXT NOT NULL CHECK(scope IN ('project','user','session','global')),
  tags TEXT DEFAULT '[]',    -- JSON array
  confidence REAL DEFAULT 0.5,
  timestamp INTEGER NOT NULL,
  last_accessed INTEGER,
  access_count INTEGER DEFAULT 0,
  source_ids TEXT DEFAULT '[]', -- JSON array de observation IDs
  superseded_by TEXT,
  pinned INTEGER DEFAULT 0,
  project_id TEXT NOT NULL,
  content_hash TEXT,          -- SHA256 para dedup
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  type,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers para manter FTS5 sincronizado
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

-- Observations table
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('tool_result','user_prompt')),
  tool_name TEXT,
  input_json TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','error')),
  content_preview TEXT,
  error_preview TEXT,
  file_paths TEXT DEFAULT '[]', -- JSON array
  ttl INTEGER NOT NULL,
  extracted INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  extraction_error TEXT
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project_id);
CREATE INDEX IF NOT EXISTS idx_observations_ttl ON observations(ttl);
CREATE INDEX IF NOT EXISTS idx_observations_extracted ON observations(extracted);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
```

### Implementação

```typescript
import Database from "better-sqlite3";

class SqliteStore {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(baseDir: string) {
    this.dbPath = join(baseDir, "memory.db");
  }

  open(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");     // melhor performance concorrente
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");    // 5s timeout para locks
    this.runSchema();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  // ── Memories ──

  insertMemory(memory: Memory): void {
    const stmt = this.db!.prepare(`
      INSERT INTO memories (id, text, embedding, type, scope, tags,
        confidence, timestamp, last_accessed, access_count,
        source_ids, superseded_by, pinned, project_id, content_hash)
      VALUES (@id, @text, @embedding, @type, @scope, @tags,
        @confidence, @timestamp, @lastAccessed, @accessCount,
        @sourceIds, @supersededBy, @pinned, @projectId, @contentHash)
    `);
    stmt.run({
      id: memory.id,
      text: memory.text,
      embedding: memory.embedding ? Buffer.from(new Float32Array(memory.embedding).buffer) : null,
      type: memory.type,
      scope: memory.scope,
      tags: JSON.stringify(memory.tags ?? []),
      confidence: memory.confidence,
      timestamp: memory.timestamp,
      lastAccessed: memory.lastAccessed ?? memory.timestamp,
      accessCount: memory.accessCount ?? 0,
      sourceIds: JSON.stringify(memory.sourceIds ?? []),
      supersededBy: memory.supersededBy ?? null,
      pinned: memory.pinned ? 1 : 0,
      projectId: memory.projectId,
      contentHash: memory.contentHash ?? null,
    });
    // FTS5 trigger insere automaticamente
  }

  updateMemory(id: string, updates: Partial<Memory>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(updates)) {
      const col = camelToSnake(key);
      if (key === "embedding" && value) {
        fields.push(`${col} = @${key}`);
        values[key] = Buffer.from(new Float32Array(value as number[]).buffer);
      } else if (key === "tags" || key === "sourceIds") {
        fields.push(`${col} = @${key}`);
        values[key] = JSON.stringify(value ?? []);
      } else if (key === "pinned") {
        fields.push(`${col} = @${key}`);
        values[key] = value ? 1 : 0;
      } else if (value !== undefined) {
        fields.push(`${col} = @${key}`);
        values[key] = value;
      }
    }

    if (fields.length === 0) return;

    fields.push("updated_at = @now");
    values.now = Date.now();

    this.db!.prepare(`
      UPDATE memories SET ${fields.join(", ")} WHERE id = @id
    `).run(values);
    // FTS5 trigger atualiza automaticamente
  }

  deleteMemory(id: string): void {
    this.db!.prepare("DELETE FROM memories WHERE id = ?").run(id);
    // FTS5 trigger remove automaticamente
  }

  getMemory(id: string): Memory | null {
    const row = this.db!.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
    return row ? this.rowToMemory(row) : null;
  }

  getMemoriesByProject(projectId: string, options?: {
    type?: MemoryType; scope?: MemoryScope; limit?: number; offset?: number;
  }): Memory[] {
    let sql = "SELECT * FROM memories WHERE project_id = ? AND superseded_by IS NULL";
    const params: unknown[] = [projectId];

    if (options?.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }
    if (options?.scope) {
      sql += " AND scope = ?";
      params.push(options.scope);
    }

    sql += " ORDER BY confidence DESC, last_accessed DESC";

    if (options?.limit) sql += ` LIMIT ${options.limit}`;
    if (options?.offset) sql += ` OFFSET ${options.offset}`;

    return (this.db!.prepare(sql).all(...params) as any[]).map(this.rowToMemory);
  }

  getAllMemories(options?: { limit?: number }): Memory[] {
    const sql = "SELECT * FROM memories WHERE superseded_by IS NULL"
      + (options?.limit ? ` LIMIT ${options.limit}` : "");
    return (this.db!.prepare(sql).all() as any[]).map(this.rowToMemory);
  }

  getMemoryCount(projectId: string): number {
    const row = this.db!.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE project_id = ? AND superseded_by IS NULL"
    ).get(projectId) as any;
    return row.count;
  }

  // ── FTS5 Search ──

  searchFts5(query: string, projectId: string, limit: number = 20): ScoredMemory[] {
    // Sanitiza query para FTS5 (evita syntax errors)
    const sanitized = query.replace(/[^\w\s"\-]/g, "").trim();
    if (!sanitized) return [];

    const rows = this.db!.prepare(`
      SELECT m.*, bm25(memories_fts) as bm25_score
      FROM memories m
      JOIN memories_fts ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.project_id = ?
        AND m.superseded_by IS NULL
      ORDER BY bm25_score
      LIMIT ?
    `).all(sanitized, projectId, limit) as any[];

    return rows.map(row => ({
      ...this.rowToMemory(row),
      score: 1 / (1 + Math.abs(row.bm25_score)), // normaliza BM25 para [0,1]
      strategy: "bm25" as const,
    }));
  }

  // ── Observations ──

  insertObservation(obs: RawObservation): void {
    const stmt = this.db!.prepare(`
      INSERT INTO observations (id, session_id, project_id, timestamp,
        type, tool_name, input_json, outcome, content_preview,
        error_preview, file_paths, ttl, extracted, retry_count)
      VALUES (@id, @sessionId, @projectId, @timestamp,
        @type, @toolName, @inputJson, @outcome, @contentPreview,
        @errorPreview, @filePaths, @ttl, @extracted, @retryCount)
    `);
    stmt.run({ /* ... todos os campos ... */ });
  }

  insertObservations(observations: RawObservation[]): void {
    const insert = this.db!.prepare(`
      INSERT INTO observations (...) VALUES (...)
    `);
    const transaction = this.db!.transaction((obs: RawObservation[]) => {
      for (const o of obs) insert.run({ /* ... */ });
    });
    transaction(observations);
  }

  deleteExpiredObservations(): number {
    const result = this.db!.prepare(
      "DELETE FROM observations WHERE ttl < ?"
    ).run(Date.now());
    return result.changes;
  }

  // ── Helpers ──

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      text: row.text,
      embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer)) : undefined,
      type: row.type,
      scope: row.scope,
      tags: JSON.parse(row.tags ?? "[]"),
      confidence: row.confidence,
      timestamp: row.timestamp,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      sourceIds: JSON.parse(row.source_ids ?? "[]"),
      supersededBy: row.superseded_by,
      pinned: row.pinned === 1,
      projectId: row.project_id,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private runSchema(): void {
    this.db!.exec(SCHEMA_DDL); // DDL definido acima
  }
}
```

## Hot Layer: RamIndex

### Dependências

```json
{
  "dependencies": {
    "faiss-node": "^0.5.0"  // ou alternativamente: usar sqlite-vec
  }
}
```

### Implementação

```typescript
import { IndexFlatIP } from "faiss-node";

class RamIndex {
  private bm25: Bm25Index | null = null;     // implementação custom em JS
  private faissIndex: IndexFlatIP | null = null;
  private memoryMap: Map<string, Memory> = new Map();
  private embeddingDim = 384;
  private isReady = false;

  async build(memories: Memory[]): Promise<void> {
    this.memoryMap.clear();

    const documents: string[] = [];
    const vectors: number[][] = [];

    for (const mem of memories) {
      this.memoryMap.set(mem.id, mem);
      documents.push(mem.text);

      if (mem.embedding && mem.embedding.length === this.embeddingDim) {
        vectors.push(mem.embedding);
      }
    }

    // Constrói BM25
    this.bm25 = new Bm25Index(documents, {
      k1: 1.5,
      b: 0.75,
    });

    // Constrói Faiss (se houver embeddings)
    if (vectors.length > 0) {
      const data = new Float32Array(vectors.length * this.embeddingDim);
      for (let i = 0; i < vectors.length; i++) {
        data.set(vectors[i], i * this.embeddingDim);
      }
      this.faissIndex = new IndexFlatIP(this.embeddingDim);
      this.faissIndex.add(data);
    }

    this.isReady = true;
  }

  search(query: string, topK: number = 20): ScoredMemory[] {
    if (!this.isReady || !this.bm25) return [];

    // BM25
    const bm25Results = this.bm25.search(query, topK * 2);

    // Vector (se disponível)
    let vectorResults: { id: number; score: number }[] = [];
    if (this.faissIndex) {
      const queryVec = this.embedQuery(query); // vem do EmbeddingService
      if (queryVec) {
        const result = this.faissIndex.search(queryVec, topK * 2);
        vectorResults = result.labels.map((id, i) => ({
          id,
          score: result.distances[i],
        }));
      }
    }

    // RRF merge
    const fused = this.rrf([
      bm25Results.map(r => ({ id: r.id, score: r.score })),
      vectorResults,
    ], topK);

    return fused.map(f => ({
      ...this.memoryMap.get(f.id)!,
      score: f.score,
      strategy: "hybrid",
    }));
  }

  // Insere/atualiza no índice sem rebuild completo
  insert(memory: Memory): void {
    if (!this.isReady) return;
    this.memoryMap.set(memory.id, memory);

    // Adiciona ao BM25
    this.bm25?.addDocument(memory.id, memory.text);

    // Adiciona ao Faiss
    if (memory.embedding && this.faissIndex) {
      const vec = new Float32Array(memory.embedding);
      this.faissIndex.add(vec);
    }
  }

  remove(id: string): void {
    this.memoryMap.delete(id);
    // BM25 e Faiss não suportam remoção eficiente (precisa rebuild)
    // Marca como dirty → próximo rebuild remove
  }

  isReady: boolean { return this.isReady; }

  private rrf(results: Array<{id: string; score: number}>[], topK: number, k: number = 60) {
    const scores = new Map<string, number>();

    for (const strategyResults of results) {
      for (let rank = 0; rank < strategyResults.length; rank++) {
        const id = strategyResults[rank].id;
        const current = scores.get(id) ?? 0;
        scores.set(id, current + 1 / (k + rank + 1));
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => ({ id, score }));
  }
}

// BM25 simplificado em JS
class Bm25Index {
  private documents: Map<string, string> = new Map();
  private docFreq: Map<string, number> = new Map(); // term → em quantos docs aparece
  private docLengths: Map<string, number> = new Map();
  private avgDocLength = 0;
  private k1: number;
  private b: number;

  constructor(documents: string[], options: { k1: number; b: number }) {
    this.k1 = options.k1;
    this.b = options.b;
    documents.forEach((doc, i) => this.addDocument(`doc_${i}`, doc));
  }

  addDocument(id: string, text: string): void {
    this.documents.set(id, text);
    const tokens = this.tokenize(text);
    this.docLengths.set(id, tokens.length);
    this.avgDocLength = Array.from(this.docLengths.values())
      .reduce((a, b) => a + b, 0) / this.docLengths.size;

    const seen = new Set<string>();
    for (const token of tokens) {
      if (!seen.has(token)) {
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
        seen.add(token);
      }
    }
  }

  search(query: string, topK: number): Array<{ id: string; score: number }> {
    const queryTokens = this.tokenize(query);
    const scores: Array<{ id: string; score: number }> = [];

    for (const [id, doc] of this.documents) {
      const docLen = this.docLengths.get(id) ?? 0;
      let score = 0;

      for (const token of queryTokens) {
        const df = this.docFreq.get(token) ?? 0;
        if (df === 0) continue;

        const tf = (doc.match(new RegExp(token, "gi")) ?? []).length;
        const idf = Math.log(
          (this.documents.size - df + 0.5) / (df + 0.5) + 1
        );
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (
          1 - this.b + this.b * (docLen / this.avgDocLength)
        );
        score += idf * (numerator / denominator);
      }

      if (score > 0) scores.push({ id, score });
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(t => t.length > 0);
  }
}
```

## Cold Layer: JsonStore

```typescript
class JsonStore {
  private dataDir: string;

  constructor(baseDir: string) {
    this.dataDir = join(baseDir, "data");
  }

  async writeMemories(memories: Memory[]): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, "memories.json");
    await writeFile(path, JSON.stringify(memories, null, 2), "utf-8");
  }

  async readMemories(): Promise<Memory[]> {
    const path = join(this.dataDir, "memories.json");
    try {
      const data = await readFile(path, "utf-8");
      return JSON.parse(data);
    } catch {
      return []; // arquivo não existe ainda
    }
  }

  async writeObservations(observations: RawObservation[]): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, "observations.json");
    await writeFile(path, JSON.stringify(observations, null, 2), "utf-8");
  }

  async readObservations(): Promise<RawObservation[]> {
    const path = join(this.dataDir, "observations.json");
    try {
      const data = await readFile(path, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  // Sincroniza cold storage com warm storage (chamado periodicamente)
  async syncFromSqlite(sqlite: SqliteStore): Promise<void> {
    if (!sqlite.isOpen()) return;

    const memories = sqlite.getAllMemories();
    await this.writeMemories(memories);

    // Observations: só synca as não-expiradas
    // (muito volume para syncar tudo)
  }
}
```

## Integração no index.ts

```typescript
// session_start
pi.on("session_start", async (_event, ctx) => {
  const baseDir = join(ctx.cwd, ".pi", "memory");

  // 1. Abre warm storage
  const sqlite = new SqliteStore(baseDir);
  sqlite.open();

  // 2. Abre cold storage
  const jsonStore = new JsonStore(baseDir);

  // 3. Reconstrói hot index
  const allMemories = sqlite.getAllMemories();
  const ramIndex = new RamIndex();
  await ramIndex.build(allMemories);

  // 4. Expurga observações expiradas
  const deleted = sqlite.deleteExpiredObservations();
  if (deleted > 0 && ctx.hasUI) {
    ctx.ui.notify(`Memory: cleaned ${deleted} expired observations`, "info");
  }

  // 5. Sync cold storage (background)
  jsonStore.syncFromSqlite(sqlite).catch(err =>
    console.error("Memory: cold sync failed", err)
  );

  // 6. Status na footer
  ctx.ui.setStatus("memory", `🧠 ${allMemories.length} memories`);
});

// session_shutdown
pi.on("session_shutdown", async () => {
  await jsonStore.syncFromSqlite(sqliteStore);
  sqliteStore.close();
});
```

## Métricas de Storage

```
Storage: ✓ SQLite + FTS5, ✓ JSON, ✓ RAM Index (hot)
  DB size:    2.3 MB
  JSON size:  1.8 MB
  RAM usage:  42 MB (1,234 memories × 384dims × 4bytes + overhead)

  Operation latencies (avg):
    insertMemory:   0.3ms (warm) + 0.1ms (hot)
    searchFts5:     15ms  (warm)
    searchRam:       8ms  (hot — BM25 only)
    searchRam:      35ms  (hot — BM25 + vector)
    getAllMemories: 12ms  (1,234 rows)
    rebuildIndex:   1.8s  (1,234 memories, cold start)
```
