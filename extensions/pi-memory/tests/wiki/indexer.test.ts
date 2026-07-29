/**
 * Testes do Indexer — scan wiki/ → popula pages table.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../../storage/sqlite-store";
import { WikiWriter } from "../../wiki/writer";
import { Indexer } from "../../wiki/indexer";
import type { Frontmatter } from "../../wiki/frontmatter";

// ── Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = path.join(tmpdir(), "pi-memory-indexer-" + randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleFrontmatter(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    type: "decision",
    scope: "project",
    title: "Test Page",
    tags: ["test"],
    confidence: 0.5,
    status: "active",
    pinned: false,
    created: "2026-07-29T12:00:00Z",
    updated: "2026-07-29T12:00:00Z",
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────

describe("Indexer", () => {
  let tempDir: string;
  let wikiRoot: string;
  let writer: WikiWriter;
  let store: SqliteStore;
  let indexer: Indexer;

  beforeEach(() => {
    tempDir = createTempDir();
    wikiRoot = path.join(tempDir, "wiki");
    writer = new WikiWriter({ rootDir: wikiRoot });
    store = new SqliteStore(path.join(tempDir, "memory.db"));
    store.open();
    indexer = new Indexer({ wikiRoot, storage: store });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── scanFull ──────────────────────────────────────────────────────

  describe("scanFull", () => {
    it("deve indexar 0 páginas se wiki vazio", () => {
      const result = indexer.scanFull();
      expect(result.total).toBe(0);
      expect(result.indexed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("deve indexar páginas do projeto", () => {
      const fm = sampleFrontmatter({ title: "Page 1" });
      writer.writePage("project", "abc123", "decisions/page1.md", fm, "# Page 1 body");

      const result = indexer.scanFull();
      expect(result.total).toBe(1);
      expect(result.indexed).toBe(1);
      expect(result.errors).toBe(0);

      const pages = store.getPagesByProject("abc123");
      expect(pages).toHaveLength(1);
      expect(pages[0].title).toBe("Page 1");
      expect(pages[0].body).toBe("# Page 1 body");
      expect(pages[0].path).toBe("decisions/page1.md");
    });

    it("deve indexar páginas globais", () => {
      const fm = sampleFrontmatter({ scope: "global", title: "Global Rule" });
      writer.writePage("global", null, "_rules/global-rule.md", fm, "body");

      const result = indexer.scanFull();
      expect(result.total).toBe(1);
      expect(result.indexed).toBe(1);

      const pages = store.getPagesByProject("_global");
      expect(pages).toHaveLength(1);
      expect(pages[0].title).toBe("Global Rule");
    });

    it("deve indexar múltiplas páginas", () => {
      writer.writePage("project", "abc", "decisions/d1.md", sampleFrontmatter({ title: "D1" }), "body1");
      writer.writePage("project", "abc", "decisions/d2.md", sampleFrontmatter({ title: "D2" }), "body2");
      writer.writePage("global", null, "_rules/r1.md", sampleFrontmatter({ scope: "global", title: "R1" }), "body3");

      const result = indexer.scanFull();
      expect(result.total).toBe(3);
      expect(result.indexed).toBe(3);

      expect(store.getPagesByProject("abc")).toHaveLength(2);
      expect(store.getPagesByProject("_global")).toHaveLength(1);
    });

    it("deve ignorar .superseded/", () => {
      const fm = sampleFrontmatter({ title: "v1" });
      writer.writePage("project", "abc", "decisions/foo.md", fm, "v1");
      writer.writePage("project", "abc", "decisions/foo.md", sampleFrontmatter({ title: "v2" }), "v2");

      const result = indexer.scanFull();
      // Só a versão atual deve ser indexada
      expect(result.total).toBe(1);
      expect(result.indexed).toBe(1);
    });

    it("deve reparar índice após corrupção (página deletada manualmente)", () => {
      writer.writePage("project", "abc", "decisions/to-delete.md", sampleFrontmatter(), "body");
      indexer.scanFull();
      expect(store.getPagesByProject("abc")).toHaveLength(1);

      // Deleta arquivo manualmente
      const fullPath = writer.resolvePath("project", "abc", "decisions/to-delete.md");
      fs.unlinkSync(fullPath);

      // Re-scan deve remover do índice
      const result = indexer.scanFull();
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(store.getPagesByProject("abc")).toHaveLength(0);
    });
  });

  // ── scanIncremental ───────────────────────────────────────────────

  describe("scanIncremental", () => {
    it("deve ignorar páginas não modificadas (mtime + hash iguais)", () => {
      writer.writePage("project", "abc", "decisions/foo.md", sampleFrontmatter(), "body");
      indexer.scanFull();

      const result = indexer.scanIncremental();
      expect(result.skipped).toBe(1);
      expect(result.indexed).toBe(0);
    });

    it("deve detectar páginas modificadas", () => {
      writer.writePage("project", "abc", "decisions/foo.md", sampleFrontmatter({ title: "v1" }), "v1");
      indexer.scanFull();

      // Modifica arquivo diretamente
      const fullPath = writer.resolvePath("project", "abc", "decisions/foo.md");
      fs.writeFileSync(fullPath, "---\ntype: decision\nscope: project\ntitle: Modified\nconfidence: 0.5\nstatus: active\npinned: false\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nmodified body", "utf-8");

      const result = indexer.scanIncremental();
      expect(result.indexed).toBe(1);
      expect(result.skipped).toBe(0);

      const page = store.getPage("abc", "decisions/foo.md");
      expect(page).not.toBeNull();
      expect(page!.title).toBe("Modified");
    });

    it("deve detectar novas páginas adicionadas", () => {
      writer.writePage("project", "abc", "decisions/existing.md", sampleFrontmatter(), "body");
      indexer.scanFull();

      writer.writePage("project", "abc", "decisions/new.md", sampleFrontmatter({ title: "New" }), "new body");

      const result = indexer.scanIncremental();
      expect(result.indexed).toBe(1);

      const pages = store.getPagesByProject("abc");
      expect(pages).toHaveLength(2);
    });
  });

  // ── searchPagesFts (integração) ───────────────────────────────────

  describe("searchPagesFts (pós-indexação)", () => {
    it("deve encontrar páginas via FTS5 após indexar", () => {
      writer.writePage("project", "abc", "decisions/hexagonal.md",
        sampleFrontmatter({ title: "Hexagonal Architecture" }),
        "The payment API follows hexagonal architecture pattern.");

      indexer.scanFull();

      const results = store.searchPagesFts("hexagonal", "abc");
      expect(results).toHaveLength(1);
      expect(results[0].page.title).toBe("Hexagonal Architecture");
      expect(results[0].snippet).toBeTruthy();
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("deve buscar em páginas globais também", () => {
      writer.writePage("global", null, "_rules/prefer-pnpm.md",
        sampleFrontmatter({ scope: "global", title: "Prefer pnpm" }),
        "Always use pnpm instead of npm in all projects.");
      writer.writePage("project", "abc", "decisions/foo.md",
        sampleFrontmatter({ title: "Foo" }), "Some other content.");

      indexer.scanFull();

      // Busca com projectId específico → retorna projeto + globais
      const results = store.searchPagesFts("pnpm", "abc");
      expect(results.length).toBeGreaterThanOrEqual(1);
      const globalResult = results.find((r) => r.page.scope === "global");
      expect(globalResult).toBeDefined();
      expect(globalResult!.page.title).toBe("Prefer pnpm");
    });

    it("deve retornar array vazio se nada encontrado", () => {
      writer.writePage("project", "abc", "decisions/foo.md",
        sampleFrontmatter(), "body");
      indexer.scanFull();

      const results = store.searchPagesFts("nonexistenttermxyz", "abc");
      expect(results).toHaveLength(0);
    });
  });
});
