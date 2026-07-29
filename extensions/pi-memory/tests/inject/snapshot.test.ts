/**
 * Testes do CacheStableInjector com páginas.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CacheStableInjector } from "../../inject/snapshot";
import type { Page, RetrievalResult } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makePage(overrides: Partial<Page> = {}): Page {
  const now = Date.now();
  return {
    id: randomUUID(),
    project_id: "test-project",
    path: "decisions/test.md",
    title: "Test",
    body: "conteúdo de teste",
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

function makeSearchFn(results: RetrievalResult[] = []) {
  return vi.fn(async (_query: string) => results);
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("CacheStableInjector", () => {
  it("deve reconstruir no primeiro getMemoryBlock (cache vazio)", async () => {
    const page = makePage({ body: "usa pnpm", type: "preference" });
    const searchFn = makeSearchFn([makeResult(page)]);
    const injector = new CacheStableInjector(searchFn);

    const block = await injector.getMemoryBlock("qual package manager?");
    expect(block).toContain("[preference]");
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it("deve reusar cache em chamadas consecutivas", async () => {
    const page = makePage({ body: "docker compose", type: "fact" });
    const searchFn = makeSearchFn([makeResult(page)]);
    const injector = new CacheStableInjector(searchFn);

    const block1 = await injector.getMemoryBlock("query 1");
    const block2 = await injector.getMemoryBlock("query 2");

    expect(block1).toBe(block2);
    expect(searchFn).toHaveBeenCalledTimes(1); // cache hit
  });

  it("deve reconstruir após invalidate explícito", async () => {
    const page = makePage({ body: "deploy via docker", type: "decision" });
    const searchFn = makeSearchFn([makeResult(page)]);
    const injector = new CacheStableInjector(searchFn);

    await injector.getMemoryBlock("como fazer deploy?");
    expect(searchFn).toHaveBeenCalledTimes(1);

    injector.invalidate();
    await injector.getMemoryBlock("como fazer deploy?");
    expect(searchFn).toHaveBeenCalledTimes(2); // rebuild após invalidate
  });

  it("deve ignorar prompt trivial (continue, ok)", async () => {
    const searchFn = makeSearchFn([]);
    const injector = new CacheStableInjector(searchFn);

    // Primeiro: prompt não trivial → busca
    await injector.getMemoryBlock("como fazer deploy do payment-api?");
    expect(searchFn).toHaveBeenCalledTimes(1);

    // Depois: prompt trivial → usa cache vazio (não chama searchFn de novo)
    // Mas o cache foi populado com "" (vazio), então não chama searchFn
    const block = await injector.getMemoryBlock("ok");
    expect(block).toBe("");
  });

  it("deve filtrar resultados abaixo do confidence threshold", async () => {
    const low = makePage({ body: "low confidence", confidence: 0.3 });
    const high = makePage({ body: "high confidence", confidence: 0.9 });
    const searchFn = makeSearchFn([
      makeResult(low, 1.0),
      makeResult(high, 0.5),
    ]);
    const injector = new CacheStableInjector(searchFn, { confidenceThreshold: 0.5 });

    const block = await injector.getMemoryBlock("como fazer deploy?");
    expect(block).toContain("high confidence");
    expect(block).not.toContain("low confidence");
  });

  it("deve retornar string vazia quando nenhum resultado atinge threshold", async () => {
    const page = makePage({ body: "low", confidence: 0.2 });
    const searchFn = makeSearchFn([makeResult(page)]);
    const injector = new CacheStableInjector(searchFn, { confidenceThreshold: 0.5 });

    const block = await injector.getMemoryBlock("query");
    expect(block).toBe("");
  });

  it("deve formatar bullets com tipo e body truncado", async () => {
    const page = makePage({ body: "Usa pnpm em todos os projetos", type: "preference" });
    const searchFn = makeSearchFn([makeResult(page)]);
    const injector = new CacheStableInjector(searchFn);

    const block = await injector.getMemoryBlock("pnpm?");
    expect(block).toContain("- [preference]");
    expect(block).toContain("Usa pnpm");
  });

  it("deve expor métricas de cache", async () => {
    const searchFn = makeSearchFn([]);
    const injector = new CacheStableInjector(searchFn);

    expect(injector.isCacheActive).toBe(false);

    await injector.getMemoryBlock("query");
    expect(injector.isCacheActive).toBe(true);
    expect(injector.turnsSinceLastRebuild).toBeGreaterThanOrEqual(0);
  });

  it("deve permitir seções customizadas (setSection/removeSection)", async () => {
    const page = makePage({ body: "deploy info", type: "fact" });
    const searchFn = makeSearchFn([makeResult(page)]);
    const injector = new CacheStableInjector(searchFn);

    injector.setSection("## Scratchpad", "notas rápidas", -1);
    const block = await injector.getMemoryBlock("deploy?");
    expect(block).toContain("## Scratchpad");
    expect(block).toContain("notas rápidas");

    injector.removeSection("## Scratchpad");
    injector.invalidate();
    const block2 = await injector.getMemoryBlock("deploy?");
    expect(block2).not.toContain("## Scratchpad");
  });

  it("deve truncar bloco que excede maxBullets", async () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(makeResult(makePage({ body: `Página ${i}`, type: "fact" })));
    }

    const searchFn = makeSearchFn(results);
    const injector = new CacheStableInjector(searchFn, { maxBullets: 3 });

    const block = await injector.getMemoryBlock("query");
    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeLessThanOrEqual(3);
  });
});
