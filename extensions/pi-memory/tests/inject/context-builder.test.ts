/**
 * Testes do Context Builder com páginas.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildMemoryBlock,
  createInjectHandler,
} from "../../inject/context-builder";
import type { Page, RetrievalResult } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makePage(overrides: Partial<Page> = {}): Page {
  const now = Date.now();
  return {
    id: randomUUID(),
    project_id: "test",
    path: "facts/test.md",
    title: "Test",
    body: "conteúdo",
    type: "fact",
    scope: "project",
    tags: [],
    confidence: 0.8,
    status: "active",
    pinned: false,
    supersedes: null,
    created_at: now,
    updated_at: now,
    content_hash: "abc",
    mtime: now,
    ...overrides,
  };
}

function makeResult(page: Page, score = 1.0): RetrievalResult {
  return { page, snippet: page.body.slice(0, 300), score, strategy: "fts5" };
}

// ── Suite: buildMemoryBlock ─────────────────────────────────────────────

describe("buildMemoryBlock", () => {
  it("deve retornar string vazia para array vazio", () => {
    expect(buildMemoryBlock([])).toBe("");
  });

  it("deve formatar página como bullet", () => {
    const page = makePage({ body: "Usa pnpm", type: "preference" });
    const block = buildMemoryBlock([makeResult(page)]);
    expect(block).toContain("## Persistent Memory");
    expect(block).toContain("- [preference] Usa pnpm");
  });

  it("deve limitar a MAX_MEMORIES (5)", () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(makeResult(makePage({ body: `Página ${i}`, type: "fact" })));
    }

    const block = buildMemoryBlock(results);
    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  it("deve respeitar maxBytes", () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(makeResult(makePage({ body: "A".repeat(200), type: "fact" })));
    }

    const block = buildMemoryBlock(results, 512);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(512);
  });

  it("deve retornar string vazia se header > maxBytes", () => {
    const page = makePage({ body: "test" });
    const block = buildMemoryBlock([makeResult(page)], 10);
    expect(block).toBe("");
  });
});

// ── Suite: createInjectHandler ──────────────────────────────────────────

describe("createInjectHandler", () => {
  it("deve injetar bloco no system prompt", async () => {
    const page = makePage({ body: "Usa docker compose", type: "fact" });
    const searchFn = vi.fn(async () => [makeResult(page)]);
    const handler = createInjectHandler({ search: searchFn });

    const result = await handler({
      prompt: "como fazer deploy?",
      systemPrompt: "system prompt original",
    });

    expect(result.systemPrompt).toContain("system prompt original");
    expect(result.systemPrompt).toContain("## Persistent Memory");
    expect(result.systemPrompt).toContain("Usa docker compose");
  });

  it("não deve injetar se não houver resultados", async () => {
    const searchFn = vi.fn(async () => []);
    const handler = createInjectHandler({ search: searchFn });

    const result = await handler({
      prompt: "query",
      systemPrompt: "original",
    });

    expect(result.systemPrompt).toBe("original");
  });

  it("deve filtrar resultados com confidence < 0.5", async () => {
    const low = makePage({ body: "low conf", confidence: 0.2 });
    const searchFn = vi.fn(async () => [makeResult(low)]);
    const handler = createInjectHandler({ search: searchFn });

    const result = await handler({
      prompt: "query",
      systemPrompt: "original",
    });

    expect(result.systemPrompt).toBe("original"); // não injetou
  });

  it("deve passar topK configurado para search", async () => {
    const searchFn = vi.fn(async () => []);
    const handler = createInjectHandler({ search: searchFn, topK: 5 });

    await handler({ prompt: "query", systemPrompt: "original" });
    expect(searchFn).toHaveBeenCalledWith("query", 5);
  });
});
