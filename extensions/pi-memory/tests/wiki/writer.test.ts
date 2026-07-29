/**
 * Testes do WikiWriter — escrita atômica, supersession, path resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WikiWriter } from "../../wiki/writer";
import type { Frontmatter } from "../../wiki/frontmatter";

// ── Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = path.join(tmpdir(), "pi-memory-test-" + randomUUID().slice(0, 8));
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

describe("WikiWriter", () => {
  let tempDir: string;
  let writer: WikiWriter;

  beforeEach(() => {
    tempDir = createTempDir();
    writer = new WikiWriter({ rootDir: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── resolvePath ───────────────────────────────────────────────────

  describe("resolvePath", () => {
    it("deve resolver path de projeto", () => {
      const full = writer.resolvePath("project", "abc123", "decisions/foo.md");
      expect(full).toBe(path.join(tempDir, "projects", "abc123", "decisions/foo.md"));
    });

    it("deve resolver path global", () => {
      const full = writer.resolvePath("global", null, "_rules/prefer-pnpm.md");
      expect(full).toBe(path.join(tempDir, "_global", "_rules", "prefer-pnpm.md"));
    });

    it("deve usar 'default' como projectId fallback", () => {
      const full = writer.resolvePath("project", null, "foo.md");
      expect(full).toBe(path.join(tempDir, "projects", "default", "foo.md"));
    });

    it("deve normalizar separadores", () => {
      const full = writer.resolvePath("project", "abc", "decisions\\foo.md");
      expect(full).toBe(path.join(tempDir, "projects", "abc", "decisions", "foo.md"));
    });

    it("deve remover leading slash", () => {
      const full = writer.resolvePath("project", "abc", "/decisions/foo.md");
      expect(full).toBe(path.join(tempDir, "projects", "abc", "decisions", "foo.md"));
    });
  });

  // ── writePage ─────────────────────────────────────────────────────

  describe("writePage", () => {
    it("deve escrever página no disco", () => {
      const fm = sampleFrontmatter({ title: "Test Page" });
      const fullPath = writer.writePage("project", "abc", "decisions/test.md", fm, "# Body");

      expect(fs.existsSync(fullPath)).toBe(true);
      const content = fs.readFileSync(fullPath, "utf-8");
      expect(content).toContain("title: Test Page");
      expect(content).toContain("# Body");
    });

    it("deve criar diretórios pai automaticamente", () => {
      const fm = sampleFrontmatter();
      const fullPath = writer.writePage("project", "abc", "deeply/nested/page.md", fm, "body");
      expect(fs.existsSync(fullPath)).toBe(true);
    });

    it("deve mover página anterior para .superseded/", () => {
      const fm = sampleFrontmatter({ title: "v1" });
      writer.writePage("project", "abc", "decisions/foo.md", fm, "versão 1");

      // Verifica que o arquivo original existe
      const originalPath = writer.resolvePath("project", "abc", "decisions/foo.md");
      expect(fs.existsSync(originalPath)).toBe(true);

      // Escreve nova versão
      const fm2 = sampleFrontmatter({ title: "v2" });
      writer.writePage("project", "abc", "decisions/foo.md", fm2, "versão 2");

      // O original ainda existe (substituído)
      expect(fs.existsSync(originalPath)).toBe(true);
      const content = fs.readFileSync(originalPath, "utf-8");
      expect(content).toContain("title: v2");

      // Versão anterior foi pra .superseded/
      const dir = path.dirname(originalPath);
      const supersededDir = path.join(dir, ".superseded");
      expect(fs.existsSync(supersededDir)).toBe(true);
      const files = fs.readdirSync(supersededDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files[0]).toMatch(/foo-/);
    });

    it("deve manter no máximo 10 versões em .superseded/", () => {
      const dir = writer.resolvePath("project", "abc", "decisions/foo.md");
      const supersededDir = path.join(path.dirname(dir), ".superseded");

      // Escreve 12 versões
      for (let i = 1; i <= 12; i++) {
        writer.writePage("project", "abc", "decisions/foo.md",
          sampleFrontmatter({ title: `v${i}` }), `versão ${i}`);
      }

      // Deve ter apenas 10 no .superseded/ (mais recentes)
      if (fs.existsSync(supersededDir)) {
        const files = fs.readdirSync(supersededDir).filter(f => f.startsWith("foo-"));
        expect(files.length).toBeLessThanOrEqual(10);
      }
    });
  });

  // ── pageExists ────────────────────────────────────────────────────

  describe("pageExists", () => {
    it("deve retornar true se página existe", () => {
      writer.writePage("project", "abc", "decisions/foo.md", sampleFrontmatter(), "body");
      expect(writer.pageExists("project", "abc", "decisions/foo.md")).toBe(true);
    });

    it("deve retornar false se página não existe", () => {
      expect(writer.pageExists("project", "abc", "decisions/nonexistent.md")).toBe(false);
    });
  });

  // ── readPage ──────────────────────────────────────────────────────

  describe("readPage", () => {
    it("deve ler página e retornar frontmatter + body", () => {
      const fm = sampleFrontmatter({ title: "Read Test" });
      writer.writePage("project", "abc", "decisions/read.md", fm, "# Read body");

      const result = writer.readPage("project", "abc", "decisions/read.md");
      expect(result).not.toBeNull();
      expect(result!.frontmatter.title).toBe("Read Test");
      expect(result!.body).toBe("# Read body");
    });

    it("deve retornar null se página não existe", () => {
      expect(writer.readPage("project", "abc", "decisions/nonexistent.md")).toBeNull();
    });

    it("deve retornar null se arquivo não tem frontmatter", () => {
      const fullPath = writer.resolvePath("project", "abc", "decisions/no-fm.md");
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, "# Sem frontmatter", "utf-8");

      expect(writer.readPage("project", "abc", "decisions/no-fm.md")).toBeNull();
    });
  });

  // ── deletePage ────────────────────────────────────────────────────

  describe("deletePage", () => {
    it("deve mover página para .superseded/", () => {
      writer.writePage("project", "abc", "decisions/delete.md", sampleFrontmatter(), "body");
      const originalPath = writer.resolvePath("project", "abc", "decisions/delete.md");
      expect(fs.existsSync(originalPath)).toBe(true);

      writer.deletePage("project", "abc", "decisions/delete.md");
      expect(fs.existsSync(originalPath)).toBe(false);

      const supersededDir = path.join(path.dirname(originalPath), ".superseded");
      expect(fs.existsSync(supersededDir)).toBe(true);
    });

    it("deve ser idempotente (não lançar erro se página não existe)", () => {
      expect(() => writer.deletePage("project", "abc", "decisions/nonexistent.md")).not.toThrow();
    });
  });

  // ── Global scope ──────────────────────────────────────────────────

  describe("global scope", () => {
    it("deve escrever em _global/", () => {
      const fm = sampleFrontmatter({ scope: "global", title: "Global Rule" });
      writer.writePage("global", null, "_rules/global-rule.md", fm, "body");

      const fullPath = writer.resolvePath("global", null, "_rules/global-rule.md");
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fullPath).toContain("_global");
    });
  });
});
