/**
 * Testes da tool memory_status (v2 — páginas wiki).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../../storage/sqlite-store";
import { PageStore } from "../../storage/page-store";
import { createMemoryStatusTool } from "../../tools/memory-status";

function createSandbox() {
  const tempDir = path.join(tmpdir(), "pi-status-" + randomUUID().slice(0, 8));
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
  tool: ReturnType<typeof createMemoryStatusTool>,
) {
  return tool.execute("test", {}, undefined, undefined, {} as never);
}

describe("memory_status tool (v2)", () => {
  it("deve retornar 0 páginas quando vazio", async () => {
    const sandbox = createSandbox();
    const tool = createMemoryStatusTool(() => ({
      storage: sandbox.store,
      pageStore: sandbox.pageStore,
      gitLayer: null,
    }));
    const result = await execute(tool);
    expect(result.content[0].text).toContain("0");
    expect(result.details?.total_pages).toBe(0);
    destroy(sandbox);
  });

  it("deve contar páginas por tipo", async () => {
    const sandbox = createSandbox();
    sandbox.pageStore.writePage({ title: "D1", body: "b", type: "decision", scope: "project", projectId: "abc123" });
    sandbox.pageStore.writePage({ title: "D2", body: "b", type: "decision", scope: "project", projectId: "abc123" });
    sandbox.pageStore.writePage({ title: "L1", body: "b", type: "lesson", scope: "project", projectId: "abc123" });

    const { Indexer } = await import("../../wiki/indexer");
    const indexer = new Indexer({ wikiRoot: sandbox.pageStore["writer"]["rootDir"], storage: sandbox.store });
    indexer.scanFull();

    const tool = createMemoryStatusTool(() => ({
      storage: sandbox.store,
      pageStore: sandbox.pageStore,
      gitLayer: null,
    }));
    const result = await execute(tool);
    expect(result.details?.total_pages).toBeGreaterThanOrEqual(3);
    expect((result.details?.by_type as Record<string, number>).decision).toBeGreaterThanOrEqual(2);
    destroy(sandbox);
  });

  it("deve reportar observations", async () => {
    const sandbox = createSandbox();
    const tool = createMemoryStatusTool(() => ({
      storage: sandbox.store,
      pageStore: sandbox.pageStore,
      gitLayer: null,
    }));
    const result = await execute(tool);
    expect(result.details?.total_observations).toBeTypeOf("number");
    expect(result.details?.pending_extraction).toBeTypeOf("number");
    destroy(sandbox);
  });
});
