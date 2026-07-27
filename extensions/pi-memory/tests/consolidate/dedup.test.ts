/**
 * Testes do Consolidate N1 — Dedup + Last-Fact-Wins.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeContent,
  contentHash,
  compositeKey,
  isContradiction,
  dedupByHash,
  lastFactWins,
  consolidateN1,
} from "../../consolidate/dedup";
import type { Memory } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMem(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: randomUUID(),
    text: "Usa pnpm em todos os projetos",
    embedding: null,
    type: "preference",
    scope: "project",
    tags: ["#preference", "#pnpm"],
    confidence: 0.5,
    timestamp: now,
    last_accessed: now,
    access_count: 0,
    source_ids: [randomUUID()],
    superseded_by: null,
    pinned: false,
    project_id: "test-project",
    content_hash: contentHash("Usa pnpm em todos os projetos"),
    ...overrides,
  };
}

// ── Suites ──────────────────────────────────────────────────────────────

describe("normalizeContent", () => {
  it("deve remover UUIDs", () => {
    const input = "Erro no container 550e8400-e29b-41d4-a716-446655440000 falhou";
    const output = normalizeContent(input);
    expect(output).not.toContain("550e8400");
    expect(output).toContain("<uuid>");
  });

  it("deve remover múltiplos UUIDs", () => {
    const input =
      "IDs: a1b2c3d4-e5f6-7890-abcd-ef1234567890 e 00000000-0000-0000-0000-000000000000";
    const output = normalizeContent(input);
    const uuidCount = (output.match(/<uuid>/g) || []).length;
    expect(uuidCount).toBe(2);
  });

  it("deve remover timestamps ISO 8601", () => {
    const input = "Executado em 2024-12-31T23:59:59.999Z com sucesso";
    const output = normalizeContent(input);
    expect(output).not.toContain("2024-12-31");
    expect(output).toContain("<date>");
  });

  it("deve remover timestamps unix (10+ dígitos)", () => {
    const input = "Timestamp: 1704067200000 ms";
    const output = normalizeContent(input);
    expect(output).toContain("<ts>");
  });

  it("deve normalizar espaços múltiplos", () => {
    const input = "muitos    espaços   aqui";
    const output = normalizeContent(input);
    expect(output).toBe("muitos espaços aqui");
  });

  it("deve fazer lowercase", () => {
    const input = "Texto COM Caixas DIFERENTES";
    const output = normalizeContent(input);
    expect(output).toBe("texto com caixas diferentes");
  });

  it("deve fazer trim", () => {
    const input = "  texto com espaços nas bordas  ";
    const output = normalizeContent(input);
    expect(output).toBe("texto com espaços nas bordas");
  });

  it("deve normalizar line endings", () => {
    const input = "linha1\r\nlinha2\rlinha3\nlinha4";
    const output = normalizeContent(input);
    expect(output).toBe("linha1 linha2 linha3 linha4");
  });

  it("deve produzir mesmo resultado para textos equivalentes", () => {
    const a = normalizeContent(
      "Erro em 2024-01-01T00:00:00Z: container a1b2c3d4-e5f6-7890-abcd-ef1234567890 falhou"
    );
    const b = normalizeContent(
      "Erro em 2025-06-15T12:30:00Z: container 00000000-1111-2222-3333-444444444444 falhou"
    );
    expect(a).toBe(b);
  });
});

describe("contentHash", () => {
  it("deve gerar hash consistente para mesmo conteúdo", () => {
    const h1 = contentHash("Usa pnpm em todos os projetos");
    const h2 = contentHash("Usa pnpm em todos os projetos");
    expect(h1).toBe(h2);
  });

  it("deve gerar hash diferente para conteúdo diferente", () => {
    const h1 = contentHash("Usa pnpm");
    const h2 = contentHash("Usa yarn");
    expect(h1).not.toBe(h2);
  });

  it("deve ignorar diferenças de timestamp/UUID no conteúdo", () => {
    const h1 = contentHash("Erro em 2024-01-01T00:00:00Z: ID a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    const h2 = contentHash("Erro em 2025-06-15T12:30:00Z: ID 00000000-1111-2222-3333-444444444444");
    expect(h1).toBe(h2);
  });

  it("deve retornar string hex de 64 caracteres (SHA256)", () => {
    const hash = contentHash("teste");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });
});

describe("compositeKey", () => {
  it("deve gerar chave composta com type + scope + tags", () => {
    const key = compositeKey("preference", "project", ["#pnpm", "#preference"]);
    expect(key).toBe("preference::project::#pnpm,#preference");
  });

  it("deve ordenar tags alfabeticamente", () => {
    const key1 = compositeKey("preference", "project", ["#b", "#a", "#c"]);
    const key2 = compositeKey("preference", "project", ["#c", "#a", "#b"]);
    expect(key1).toBe(key2);
  });

  it("deve normalizar tags (lowercase, trim)", () => {
    const key1 = compositeKey("preference", "project", ["  #PNPM  "]);
    const key2 = compositeKey("preference", "project", ["#pnpm"]);
    expect(key1).toBe(key2);
  });

  it("deve filtrar tags vazias", () => {
    const key = compositeKey("preference", "project", ["#a", "", "  ", "#b"]);
    expect(key).toBe("preference::project::#a,#b");
  });

  it("deve distinguir types diferentes", () => {
    const k1 = compositeKey("preference", "project", ["#a"]);
    const k2 = compositeKey("decision", "project", ["#a"]);
    expect(k1).not.toBe(k2);
  });

  it("deve distinguir scopes diferentes", () => {
    const k1 = compositeKey("preference", "project", ["#a"]);
    const k2 = compositeKey("preference", "user", ["#a"]);
    expect(k1).not.toBe(k2);
  });
});

describe("isContradiction", () => {
  it("deve detectar 'não usa mais'", () => {
    expect(isContradiction("não usa mais docker", "usa docker")).toBe(true);
  });

  it("deve detectar 'mudou para'", () => {
    expect(isContradiction("mudou de npm para pnpm", "usa npm")).toBe(true);
  });

  it("deve detectar 'agora prefere'", () => {
    expect(isContradiction("agora prefere vitest", "usa jest")).toBe(true);
  });

  it("deve detectar 'substituído por'", () => {
    expect(isContradiction("substituído por pnpm", "usava npm")).toBe(true);
  });

  it("deve detectar 'nunca use'", () => {
    expect(isContradiction("nunca use console.log em produção", "")).toBe(true);
  });

  it("deve detectar 'evite usar'", () => {
    expect(isContradiction("evite usar var em vez de const", "")).toBe(true);
  });

  it("deve detectar 'descontinuado'", () => {
    expect(isContradiction("módulo xyz está descontinuado", "use módulo xyz")).toBe(
      true
    );
  });

  it("deve detectar 'parou de usar'", () => {
    expect(isContradiction("parou de usar MongoDB", "usa MongoDB")).toBe(true);
  });

  it("deve retornar false para afirmação normal", () => {
    expect(isContradiction("usa pnpm em todos os projetos", "")).toBe(false);
  });

  it("deve retornar false para texto sem contradição", () => {
    expect(
      isContradiction("Testes usam vitest com @test/helpers", "")
    ).toBe(false);
  });

  it("deve ser case-insensitive", () => {
    expect(isContradiction("NÃO USA MAIS docker", "usa docker")).toBe(true);
    expect(isContradiction("Mudou PARA pnpm", "usa npm")).toBe(true);
  });
});

describe("dedupByHash", () => {
  it("deve criar nova se não existe hash igual", () => {
    const mem = makeMem();
    const result = dedupByHash(mem, null);
    expect(result.created).toBe(true);
    expect(result.memory.id).toBe(mem.id);
  });

  it("deve atualizar existente se hash igual encontrado", () => {
    const mem = makeMem({ text: "original" });
    const hash = contentHash("original");
    const existing = makeMem({
      id: "existing-1",
      text: "original",
      content_hash: hash,
      confidence: 0.5,
      access_count: 2,
      source_ids: ["s1"],
    });

    const result = dedupByHash(mem, existing);
    expect(result.created).toBe(false);
    expect(result.memory.id).toBe("existing-1");
    expect(result.memory.confidence).toBe(0.55); // +0.05
    expect(result.memory.access_count).toBe(3); // +1
  });

  it("deve capar confidence em 1.0", () => {
    const mem = makeMem();
    const existing = makeMem({
      id: "existing-1",
      confidence: 0.99,
      access_count: 0,
    });

    const result = dedupByHash(mem, existing);

    expect(result.memory.confidence).toBe(1.0);
  });

  it("deve adicionar novos source_ids", () => {
    const mem = makeMem({ source_ids: ["new-src"] });
    const existing = makeMem({
      id: "existing-1",
      source_ids: ["old-src"],
    });

    const result = dedupByHash(mem, existing);

    expect(result.memory.source_ids).toContain("old-src");
    expect(result.memory.source_ids).toContain("new-src");
  });

  it("não deve duplicar source_ids", () => {
    const mem = makeMem({ source_ids: ["src-1"] });
    const existing = makeMem({
      id: "existing-1",
      source_ids: ["src-1"],
    });

    const result = dedupByHash(mem, existing);

    const ids = result.memory.source_ids;
    expect(ids.filter((id) => id === "src-1")).toHaveLength(1);
  });

  it("deve atualizar last_accessed", () => {
    const mem = makeMem();
    const existing = makeMem({
      id: "existing-1",
      last_accessed: 1000,
    });

    const result = dedupByHash(mem, existing);

    expect(result.memory.last_accessed).toBeGreaterThan(1000);
  });

  it("deve ignorar memória superseded_by", () => {
    const mem = makeMem();
    const existing = makeMem({
      id: "existing-1",
      superseded_by: "other-id",
    });

    const result = dedupByHash(mem, existing);

    // Deve criar nova porque a existente foi superada
    expect(result.created).toBe(true);
    expect(result.memory.id).toBe(mem.id);
  });
});

describe("lastFactWins", () => {
  it("deve criar nova se não existe chave", () => {
    const mem = makeMem();
    const result = lastFactWins(mem, null);
    expect(result.supersededId).toBeUndefined();
    expect(result.memory.id).toBe(mem.id);
  });

  it("deve criar nova se existente foi superada", () => {
    const mem = makeMem();
    const existing = makeMem({
      id: "old",
      superseded_by: "other",
    });
    const result = lastFactWins(mem, existing);
    expect(result.memory.id).toBe(mem.id);
  });

  it("deve fazer supersede quando nova contradiz existente", () => {
    const existing = makeMem({
      id: "old-mem",
      text: "usuário usa npm",
    });

    const newMem = makeMem({
      id: "new-mem",
      text: "agora prefere pnpm em vez de npm",
    });

    const result = lastFactWins(newMem, existing);

    expect(result.supersededId).toBe("old-mem");
    expect(result.memory.id).toBe("new-mem");
    // Herda access_count
    expect(result.memory.access_count).toBe(existing.access_count + 1);
  });

  it("deve atualizar texto quando não há contradição", () => {
    const existing = makeMem({
      id: "old-mem",
      text: "usa pnpm",
      confidence: 0.5,
      access_count: 3,
    });

    const newMem = makeMem({
      id: "new-mem",
      text: "usa pnpm em todos os projetos",
    });

    const result = lastFactWins(newMem, existing);

    expect(result.supersededId).toBeUndefined();
    expect(result.memory.id).toBe("old-mem");
    expect(result.memory.text).toBe("usa pnpm em todos os projetos");
    expect(result.memory.confidence).toBe(0.55); // +0.05
    expect(result.memory.access_count).toBe(4); // +1
  });

  it("deve herdar source_ids em caso de contradição", () => {
    const existing = makeMem({ id: "old", source_ids: ["old-src"] });
    const newMem = makeMem({
      id: "new",
      text: "mudou para nova ferramenta",
      source_ids: ["new-src"],
    });

    const result = lastFactWins(newMem, existing);

    expect(result.memory.source_ids).toContain("old-src");
    expect(result.memory.source_ids).toContain("new-src");
  });
});

describe("consolidateN1 (pipeline completo)", () => {
  it("deve criar quando não há conflitos (hash nem chave)", () => {
    const mem = makeMem();
    const result = consolidateN1({
      memory: mem,
      getByHash: () => null,
      getByKey: () => null,
    });

    expect(result.action).toBe("create");
    expect(result.memory.id).toBe(mem.id);
  });

  it("deve atualizar por hash (step 1)", () => {
    const hash = contentHash("teste");
    const existing = makeMem({ id: "exist", content_hash: hash, text: "teste" });
    const mem = makeMem({ content_hash: hash, text: "teste" });

    const result = consolidateN1({
      memory: mem,
      getByHash: () => existing,
      getByKey: () => null,
    });

    expect(result.action).toBe("update");
    expect(result.memory.id).toBe("exist");
  });

  it("deve fazer supersede por chave quando há contradição (step 2)", () => {
    const existing = makeMem({
      id: "old",
      text: "usa npm",
      type: "preference",
      scope: "project",
      tags: ["#npm"],
    });

    const key = compositeKey("preference", "project", ["#npm"]);
    const newMem = makeMem({
      id: "new",
      text: "agora prefere pnpm",
      type: "preference",
      scope: "project",
      tags: ["#npm"],
    });

    const result = consolidateN1({
      memory: newMem,
      getByHash: () => null,
      getByKey: (k) => (k === key ? existing : null),
    });

    expect(result.action).toBe("supersede");
    expect(result.supersededId).toBe("old");
    expect(result.memory.id).toBe("new");
  });

  it("deve atualizar por chave quando não há contradição (step 2)", () => {
    const existing = makeMem({
      id: "old",
      text: "usa pnpm",
      type: "preference",
      scope: "project",
      tags: ["#pnpm"],
    });

    const key = compositeKey("preference", "project", ["#pnpm"]);
    const newMem = makeMem({
      id: "new",
      text: "usa pnpm em todos os projetos sempre",
      type: "preference",
      scope: "project",
      tags: ["#pnpm"],
    });

    const result = consolidateN1({
      memory: newMem,
      getByHash: () => null,
      getByKey: (k) => (k === key ? existing : null),
    });

    expect(result.action).toBe("update");
    expect(result.memory.id).toBe("old");
  });
});
