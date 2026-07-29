/**
 * Testes da tool memory_search (v2 — páginas wiki).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../../storage/sqlite-store";
import { PageStore } from "../../storage/page-store";
import { createMemorySearchTool } from "../../tools/memory-search";

function createSandbox() {
  const tempDir = path.join(tmpdir(), "pi-search-" + randomUUID().slice(0, 8));
  const dbPath = path.join(tempDir, "memory.db");
  const wikiRoot = path.join(tempDir, "wiki");
  fs.mkdirSync(wikiRoot, { recursive: true });
  const store = new SqliteStore(dbPath);
  store.open();
  const pageStore = new PageStore(wikiRoot, store, { enabled: false });
  return { tempDir, store, pageStore, wikiRoot };
}

function destroy(s: { tempDir: string; store: SqliteStore }): void {
  try { s.store.close(); fs.rmSync(s.tempDir, { recursive: true, force: true }); } catch {}
}

async function execute(
  tool: ReturnType<typeof createMemorySearchTool>,
  params: Record<string, unknown>,
) {
  return tool.execute("test", params, undefined, undefined, {} as never);
}

describe("memory_search tool (v2)", () => {
  it("deve retornar 'No pages found' quando vazio", async () => {
    const sandbox = createSandbox();
    const tool = createMemorySearchTool(() => sandbox.pageStore, "abc123");
    const result = await execute(tool, { query: "nonexistent" });
    expect(result.content[0].text).toContain("No pages");
    destroy(sandbox);
  });

  it("deve encontrar páginas por termo", async () => {
    const sandbox = createSandbox();
    sandbox.pageStore.writePage({
      title: "Hexagonal Architecture", body: "Hexagonal architecture pattern", type: "decision", scope: "project", projectId: "abc123",
    });
    sandbox.pageStore.writePage({
      title: "Prefer pnpm", body: "Use pnpm", type: "preference", scope: "global", projectId: null,
    });

    const tool = createMemorySearchTool(() => sandbox.pageStore, "abc123");
    const result = await execute(tool, { query: "hexagonal" });
    expect(result.content[0].text).toContain("Hexagonal");
    destroy(sandbox);
  });

  it("deve filtrar por type", async () => {
    const sandbox = createSandbox();
    sandbox.pageStore.writePage({
      title: "Decision", body: "Body", type: "decision", scope: "project", projectId: "abc123",
    });
    sandbox.pageStore.writePage({
      title: "Lesson", body: "Body", type: "lesson", scope: "project", projectId: "abc123",
    });

    const tool = createMemorySearchTool(() => sandbox.pageStore, "abc123");
    const result = await execute(tool, { query: "body", type: "decision" });
    expect(result.content[0].text).toContain("Decision");
    expect(result.content[0].text).not.toContain("Lesson");
    destroy(sandbox);
  });

  it("deve filtrar por scope", async () => {
    const sandbox = createSandbox();
    sandbox.pageStore.writePage({
      title: "Global Rule", body: "Body", type: "preference", scope: "global", projectId: null,
    });
    sandbox.pageStore.writePage({
      title: "Project Rule", body: "Body", type: "preference", scope: "project", projectId: "abc123",
    });

    const tool = createMemorySearchTool(() => sandbox.pageStore, "abc123");
    const result = await execute(tool, { query: "body", scope: "global" });
    expect(result.content[0].text).toContain("Global Rule");
    expect(result.content[0].text).not.toContain("Project Rule");
    destroy(sandbox);
  });
});
