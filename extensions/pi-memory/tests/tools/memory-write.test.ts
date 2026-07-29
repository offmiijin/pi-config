/**
 * Testes da tool memory_write (v2 — páginas markdown).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createMemoryWriteTool } from "../../tools/memory-write";
import { SqliteStore } from "../../storage/sqlite-store";
import { PageStore } from "../../storage/page-store";

// ── Helpers ────────────────────────────────────────────────────────────

function createSandbox(): { tempDir: string; store: SqliteStore; pageStore: PageStore } {
  const tempDir = path.join(tmpdir(), "pi-memory-write-" + randomUUID().slice(0, 8));
  const dbPath = path.join(tempDir, "memory.db");
  const wikiRoot = path.join(tempDir, "wiki");
  fs.mkdirSync(wikiRoot, { recursive: true });

  const store = new SqliteStore(dbPath);
  store.open();
  const pageStore = new PageStore(wikiRoot, store);

  return { tempDir, store, pageStore };
}

function destroySandbox(sandbox: { tempDir: string; store: SqliteStore }): void {
  try {
    sandbox.store.close();
    fs.rmSync(sandbox.tempDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ── Contexto de execução mock ──────────────────────────────────────────

const mockCtx = {} as unknown as Parameters<
  ReturnType<typeof createMemoryWriteTool>["execute"]
>[4];

async function executeTool(
  tool: ReturnType<typeof createMemoryWriteTool>,
  params: Record<string, unknown>,
) {
  return tool.execute("test-call-id", params, undefined, undefined, mockCtx);
}

// ── Suite ──────────────────────────────────────────────────────────────

describe("memory_write tool (v2)", () => {
  describe("com PageStore real", () => {
    it("deve criar página markdown no disco e no índice", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        const result = await executeTool(tool, {
          title: "Hexagonal Architecture",
          body: "The payment API follows hexagonal architecture.",
          type: "decision",
          scope: "project",
        });

        expect(result.content[0].text).toContain("Page saved");
        expect(result.details?.path).toContain("decisions/hexagonal-architecture.md");

        // Verifica que página está no SQLite
        const pages = sandbox.store.getPagesByProject("abc123");
        expect(pages).toHaveLength(1);
        expect(pages[0].title).toBe("Hexagonal Architecture");

        // Verifica que arquivo .md existe no disco
        const fullPath = sandbox.pageStore["writer"].resolvePath(
          "project", "abc123", "decisions/hexagonal-architecture.md"
        );
        expect(fs.existsSync(fullPath)).toBe(true);
      } finally {
        destroySandbox(sandbox);
      }
    });

    it("deve criar página global em _global/", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        await executeTool(tool, {
          title: "Prefer pnpm",
          body: "Use pnpm in all projects.",
          type: "preference",
          scope: "global",
        });

        const pages = sandbox.store.getPagesByProject("_global");
        expect(pages).toHaveLength(1);
        expect(pages[0].title).toBe("Prefer pnpm");
      } finally {
        destroySandbox(sandbox);
      }
    });

    it("deve aceitar path explícito", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        await executeTool(tool, {
          path: "gotchas/custom-path",
          title: "Custom Path",
          body: "Body",
          type: "lesson",
          scope: "project",
        });

        const pages = sandbox.store.getPagesByProject("abc123");
        expect(pages).toHaveLength(1);
        expect(pages[0].path).toBe("gotchas/custom-path.md");
      } finally {
        destroySandbox(sandbox);
      }
    });

    it("deve resolver conflito de path com sufixo numérico", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        // Primeira escrita
        await executeTool(tool, {
          title: "Same Title",
          body: "Version 1",
          type: "decision",
          scope: "project",
        });

        // Segunda (path gerado igual → conflito resolvido com -2)
        const result2 = await executeTool(tool, {
          title: "Same Title",
          body: "Version 2",
          type: "decision",
          scope: "project",
        });

        expect(result2.details?.path).toContain("-2");

        const pages = sandbox.store.getPagesByProject("abc123");
        expect(pages).toHaveLength(2);
      } finally {
        destroySandbox(sandbox);
      }
    });

    it("deve aceitar parâmetros antigos (text) com backward compat", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        const result = await executeTool(tool, {
          text: "This is from old API parameter",
          type: "fact",
          scope: "project",
        });

        expect(result.content[0].text).toContain("Page saved");
        const pages = sandbox.store.getPagesByProject("abc123");
        expect(pages).toHaveLength(1);
        expect(pages[0].title).toContain("This is from old API");
      } finally {
        destroySandbox(sandbox);
      }
    });

    it("deve retornar erro se body vazio", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        const result = await executeTool(tool, {
          title: "Empty",
          body: "",
          type: "decision",
          scope: "project",
        });

        expect(result.content[0].text).toContain("Error");
      } finally {
        destroySandbox(sandbox);
      }
    });

    it("deve aceitar tags e pinned", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        await executeTool(tool, {
          title: "Tagged Page",
          body: "Content",
          type: "lesson",
          scope: "project",
          tags: ["debug", "oauth"],
          pinned: true,
        });

        const pages = sandbox.store.getPagesByProject("abc123");
        expect(pages).toHaveLength(1);
        expect(pages[0].tags).toContain("debug");
        expect(pages[0].pinned).toBe(true);
      } finally {
        destroySandbox(sandbox);
      }
    });
  });

  describe("scope migration", () => {
    it("deve migrar scope 'user' para 'project'", async () => {
      const sandbox = createSandbox();
      const tool = createMemoryWriteTool(() => sandbox.pageStore, "abc123");

      try {
        await executeTool(tool, {
          title: "Test",
          body: "Body",
          type: "decision",
          scope: "user",
        });

        const pages = sandbox.store.getPagesByProject("abc123");
        expect(pages).toHaveLength(1);
        expect(pages[0].scope).toBe("project");
      } finally {
        destroySandbox(sandbox);
      }
    });
  });
});
