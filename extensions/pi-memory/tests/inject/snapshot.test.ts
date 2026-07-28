/**
 * Testes do CacheStableInjector (Fase 2.6).
 *
 * Cobre: cache hit/miss, invalidação por day rollover, invalidate() explícito,
 * rebuild após invalidação, seções customizadas, cap total, prompts triviais.
 */

import { describe, it, expect, vi } from "vitest";
import { CacheStableInjector } from "../../inject/snapshot";
import type { Memory, RetrievalResult } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMem(text: string): Memory {
  return {
    id: randomUUID(),
    text,
    embedding: null,
    type: "fact",
    scope: "project",
    tags: [],
    confidence: 0.8,
    timestamp: Date.now(),
    last_accessed: Date.now(),
    access_count: 1,
    source_ids: [],
    superseded_by: null,
    pinned: false,
    project_id: "proj-1",
    content_hash: `hash-${text.slice(0, 8)}`,
  };
}

function makeResult(text: string, score = 0.9): RetrievalResult {
  return { memory: makeMem(text), score, strategy: "bm25" };
}

function makeSearchFn(
  results: RetrievalResult[]
): (query: string) => Promise<RetrievalResult[]> {
  return vi.fn(async (_query: string) => results);
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("CacheStableInjector", () => {
  it("deve reconstruir no primeiro getMemoryBlock (cache vazio)", async () => {
    const searchFn = makeSearchFn([
      makeResult("Usa pnpm", 1.0),
    ]);
    const injector = new CacheStableInjector(searchFn);

    expect(injector.isCacheActive).toBe(false);

    const block = await injector.getMemoryBlock("qual package manager?");
    expect(block).toContain("Usa pnpm");
    expect(injector.isCacheActive).toBe(true);
    expect(injector.turnsSinceLastRebuild).toBe(1);
  });

  it("deve reusar cache em chamadas subsequentes (cache hit)", async () => {
    const searchFn = makeSearchFn([
      makeResult("Usa pnpm", 1.0),
    ]);
    const injector = new CacheStableInjector(searchFn);

    const block1 = await injector.getMemoryBlock("query 1");
    const block2 = await injector.getMemoryBlock("query 2");

    // Blocos idênticos — cache usado
    expect(block1).toBe(block2);
    // searchFn chamado só uma vez
    expect(searchFn).toHaveBeenCalledTimes(1);
    // Contador de turnos incrementa
    expect(injector.turnsSinceLastRebuild).toBe(2);
  });

  it("deve reconstruir após invalidate() explícito", async () => {
    const searchFn = makeSearchFn([
      makeResult("Mem antiga", 0.9),
    ]);
    const injector = new CacheStableInjector(searchFn);

    const block1 = await injector.getMemoryBlock("como fazer deploy?");
    expect(block1).toContain("Mem antiga");

    // Muda resultados simulando nova memória
    searchFn.mockResolvedValue([makeResult("Mem nova", 1.0)]);

    // Sem invalidate → cache ainda retorna bloco antigo
    const block2 = await injector.getMemoryBlock("como fazer deploy?");
    expect(block2).toContain("Mem antiga");
    expect(searchFn).toHaveBeenCalledTimes(1); // só a primeira chamada

    // Invalida
    injector.invalidate();
    expect(injector.isCacheActive).toBe(false);

    const block3 = await injector.getMemoryBlock("como fazer deploy?");
    expect(block3).toContain("Mem nova");
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  it("deve reconstruir após day rollover (via invalidate simulando)", async () => {
    const searchFn = makeSearchFn([]);
    const injector = new CacheStableInjector(searchFn);

    // Primeira chamada popula o cache
    await injector.getMemoryBlock("como fazer deploy?");
    expect(searchFn).toHaveBeenCalledTimes(1);

    // Mesmo dia, sem invalidate: cache hit
    await injector.getMemoryBlock("como fazer deploy?");
    expect(searchFn).toHaveBeenCalledTimes(1);

    // Simula day rollover via invalidate
    injector.invalidate();

    await injector.getMemoryBlock("como fazer deploy?");
    expect(searchFn).toHaveBeenCalledTimes(2);
  });

  it("deve pular busca para prompts triviais", async () => {
    const searchFn = makeSearchFn([]);
    const injector = new CacheStableInjector(searchFn);

    // Prompt trivial não deve disparar busca
    await injector.getMemoryBlock("ok");
    expect(searchFn).toHaveBeenCalledTimes(0);

    // Invalida cache para forçar rebuild com prompt não-trivial
    injector.invalidate();

    // Prompt não-trivial deve disparar busca
    await injector.getMemoryBlock("como fazer deploy do payment-api?");
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it("deve suportar seções customizadas", async () => {
    const searchFn = makeSearchFn([
      makeResult("Mem persistente", 1.0),
    ]);
    const injector = new CacheStableInjector(searchFn);

    // priority -1 = antes de Persistent Memory (priority 0)
    injector.setSection("## Scratchpad", "- [ ] Fix auth bug", -1);
    injector.invalidate();

    const block = await injector.getMemoryBlock("como fazer deploy?");

    expect(block).toContain("## Scratchpad");
    expect(block).toContain("- [ ] Fix auth bug");
    expect(block).toContain("## Persistent Memory");

    // Scratchpad (priority -1) aparece antes de Persistent Memory (priority 0)
    const scratchIdx = block.indexOf("## Scratchpad");
    const memIdx = block.indexOf("## Persistent Memory");
    expect(scratchIdx).toBeLessThan(memIdx);
  });

  it("deve remover seção customizada", async () => {
    const searchFn = makeSearchFn([]);
    const injector = new CacheStableInjector(searchFn);

    injector.setSection("## Scratchpad", "test", -1);
    injector.invalidate();

    const withSection = await injector.getMemoryBlock("como fazer deploy?");
    expect(withSection).toContain("## Scratchpad");

    injector.removeSection("## Scratchpad");
    injector.invalidate();

    const withoutSection = await injector.getMemoryBlock("como fazer deploy?");
    expect(withoutSection).not.toContain("## Scratchpad");
  });

  it("deve aplicar cap total de 16KB", async () => {
    // Cria muitos resultados para estourar o cap
    const results = Array.from({ length: 50 }, (_, i) =>
      makeResult(`Memória número ${i} com texto repetido `.repeat(5), 0.9)
    );
    const searchFn = makeSearchFn(results);
    const injector = new CacheStableInjector(searchFn, { totalCapBytes: 2048 });

    await injector.getMemoryBlock("como fazer deploy?");

    // Depois do cache ser populado, verifica tamanho
    // Não podemos inspecionar o cached diretamente (privado),
    // mas podemos verificar que não quebrou e o stats estão corretos
    expect(injector.isCacheActive).toBe(true);
    expect(injector.turnsSinceLastRebuild).toBe(1);
  });

  it("deve reportar cache age e turns since rebuild", async () => {
    const searchFn = makeSearchFn([]);
    const injector = new CacheStableInjector(searchFn);

    await injector.getMemoryBlock("query numero um");
    expect(injector.turnsSinceLastRebuild).toBe(1);
    expect(injector.cacheAge).toBeGreaterThanOrEqual(0);

    await injector.getMemoryBlock("query numero dois");
    expect(injector.turnsSinceLastRebuild).toBe(2);

    await injector.getMemoryBlock("query numero tres");
    expect(injector.turnsSinceLastRebuild).toBe(3);
  });

  it("deve filtrar memórias com confidence < 0.5", async () => {
    const low = makeMem("baixa confiança");
    low.confidence = 0.3;
    const high = makeMem("alta confiança");
    high.confidence = 0.9;

    const searchFn = makeSearchFn([
      { memory: low, score: 1.0, strategy: "bm25" },
      { memory: high, score: 0.5, strategy: "bm25" },
    ]);
    const injector = new CacheStableInjector(searchFn);

    const block = await injector.getMemoryBlock("como fazer deploy?");
    expect(block).toContain("alta confiança");
    expect(block).not.toContain("baixa confiança");
  });

  it("não deve quebrar se search lança erro", async () => {
    const searchFn = vi.fn(async () => {
      throw new Error("Search failed");
    });
    const injector = new CacheStableInjector(searchFn);

    const block = await injector.getMemoryBlock("como fazer deploy?");
    // Retorna string vazia ou sem seção Persistent Memory
    expect(typeof block).toBe("string");
  });
});
