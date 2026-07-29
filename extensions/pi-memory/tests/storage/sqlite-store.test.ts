/**
 * Testes do SqliteStore — camada warm de storage (páginas + observações).
 *
 * Usa banco em memória (:memory:) para isolamento e velocidade.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStore } from "../../storage/sqlite-store";
import type { Page, RawObservation } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makePage(overrides: Partial<Page> = {}): Page {
  const now = Date.now();
  return {
    id: randomUUID(),
    project_id: "test-project",
    path: "decisions/test.md",
    title: "Test",
    body: "Usa pnpm em todos os projetos",
    type: "preference",
    scope: "project",
    tags: ["pnpm"],
    confidence: 0.8,
    status: "active",
    pinned: false,
    supersedes: null,
    created_at: now,
    updated_at: now,
    content_hash: "abc123",
    mtime: now,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<RawObservation> = {}): RawObservation {
  const now = Date.now();
  return {
    id: randomUUID(),
    session_id: randomUUID(),
    project_id: "test-project",
    timestamp: now,
    type: "tool_result",
    tool_name: "bash",
    input_json: JSON.stringify({ command: "pnpm install" }),
    outcome: "success",
    content_preview: "Packages installed successfully",
    error_preview: null,
    file_paths: ["package.json"],
    ttl: now + 7 * 24 * 60 * 60 * 1000,
    extracted: false,
    ...overrides,
  };
}

function makeEmbedding(dim = 384): Float32Array {
  const emb = new Float32Array(dim);
  for (let i = 0; i < dim; i++) emb[i] = Math.random() * 2 - 1;
  return emb;
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });

  // ── Lifecycle ─────────────────────────────────────────────────────

  it("deve abrir e fechar sem erros", () => {
    expect(() => store.close()).not.toThrow();
  });

  it("deve recriar tabelas ao abrir (idempotente)", () => {
    store.close();
    store = new SqliteStore(":memory:");
    expect(store.countPages()).toBe(0);
  });

  // ── Page CRUD ──────────────────────────────────────────────────────

  describe("insertPage / getPage", () => {
    it("deve inserir e recuperar página por project_id + path", () => {
      const page = makePage();
      store.insertPage(page);
      const retrieved = store.getPage(page.project_id, page.path);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe(page.title);
      expect(retrieved!.body).toBe(page.body);
    });

    it("deve retornar null para página inexistente", () => {
      expect(store.getPage("no-project", "no/path.md")).toBeNull();
    });

    it("deve recuperar página por id", () => {
      const page = makePage();
      store.insertPage(page);
      const retrieved = store.getPageById(page.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(page.id);
    });

    it("deve lançar erro ao inserir path duplicado no mesmo projeto", () => {
      const page = makePage({ path: "decisions/dup.md" });
      store.insertPage(page);
      expect(() => store.insertPage(makePage({ path: "decisions/dup.md" }))).toThrow();
    });

    it("deve armazenar tags, confidence, status, pinned", () => {
      const page = makePage({
        tags: ["docker", "deploy"],
        confidence: 0.9,
        status: "active",
        pinned: true,
      });
      store.insertPage(page);
      const retrieved = store.getPage(page.project_id, page.path)!;
      expect(retrieved.tags).toEqual(["docker", "deploy"]);
      expect(retrieved.confidence).toBe(0.9);
      expect(retrieved.status).toBe("active");
      expect(retrieved.pinned).toBe(true);
    });
  });

  describe("getPagesByProject", () => {
    it("deve filtrar por project_id", () => {
      const projA = makePage({ project_id: "proj-a", path: "facts/a.md", body: "A" });
      const projB = makePage({ project_id: "proj-b", path: "facts/b.md", body: "B" });
      store.insertPage(projA);
      store.insertPage(projB);

      expect(store.getPagesByProject("proj-a")).toHaveLength(1);
      expect(store.getPagesByProject("proj-b")).toHaveLength(1);
    });

    it("deve ordenar por updated_at DESC", () => {
      const older = makePage({ path: "facts/old.md", updated_at: 1000 });
      const newer = makePage({ path: "facts/new.md", updated_at: 2000 });
      store.insertPage(older);
      store.insertPage(newer);

      const pages = store.getPagesByProject("test-project");
      expect(pages[0].path).toBe("facts/new.md");
    });
  });

  describe("updatePage", () => {
    it("deve atualizar campos da página", () => {
      const page = makePage();
      store.insertPage(page);

      const updated: Page = { ...page, body: "texto atualizado", confidence: 0.5 };
      store.updatePage(updated);

      const retrieved = store.getPage(page.project_id, page.path)!;
      expect(retrieved.body).toBe("texto atualizado");
      expect(retrieved.confidence).toBe(0.5);
    });

    it("deve atualizar status para superseded", () => {
      const page = makePage();
      store.insertPage(page);

      store.updatePage({ ...page, status: "superseded" });
      const retrieved = store.getPage(page.project_id, page.path)!;
      expect(retrieved.status).toBe("superseded");
      // Não deve contar como ativa
      expect(store.countPages()).toBe(0);
    });
  });

  describe("deletePage", () => {
    it("deve remover página do índice", () => {
      const page = makePage();
      store.insertPage(page);
      store.deletePage(page.project_id, page.path);
      expect(store.getPage(page.project_id, page.path)).toBeNull();
    });

    it("não deve quebrar ao deletar página inexistente", () => {
      expect(() => store.deletePage("no-project", "no/path.md")).not.toThrow();
    });
  });

  describe("deleteAllPages", () => {
    it("deve remover todas as páginas do projeto", () => {
      store.insertPage(makePage({ project_id: "proj-a", path: "facts/a.md" }));
      store.insertPage(makePage({ project_id: "proj-a", path: "facts/b.md" }));
      store.insertPage(makePage({ project_id: "proj-b", path: "facts/c.md" }));

      store.deleteAllPages("proj-a");
      expect(store.getPagesByProject("proj-a")).toHaveLength(0);
      expect(store.getPagesByProject("proj-b")).toHaveLength(1);
    });
  });

  describe("pageExists", () => {
    it("deve retornar true se página existe", () => {
      const page = makePage();
      store.insertPage(page);
      expect(store.pageExists(page.project_id, page.path)).toBe(true);
    });

    it("deve retornar false se não existe", () => {
      expect(store.pageExists("none", "none.md")).toBe(false);
    });
  });

  // ── Embeddings ────────────────────────────────────────────────────

  describe("page embeddings", () => {
    it("deve persistir embedding de página", () => {
      const page = makePage();
      store.insertPage(page);

      const emb = makeEmbedding();
      store.updatePageEmbedding(page.id, emb);

      const pagesWithEmb = store.getPagesWithEmbeddings(page.project_id);
      expect(pagesWithEmb).toHaveLength(1);
      expect(pagesWithEmb[0].id).toBe(page.id);
    });

    it("deve retornar embedding data", () => {
      const page = makePage();
      store.insertPage(page);

      const emb = makeEmbedding();
      store.updatePageEmbedding(page.id, emb);

      const data = store.getPagesWithEmbeddingData(page.project_id);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(page.id);
      expect(data[0].embedding.length).toBe(384);
    });

    it("getPagesWithoutEmbedding deve retornar páginas sem embedding", () => {
      store.insertPage(makePage({ path: "facts/with.md" }));
      store.insertPage(makePage({ path: "facts/without.md" }));

      const pageWith = store.getPage("test-project", "facts/with.md")!;
      store.updatePageEmbedding(pageWith.id, makeEmbedding());

      const without = store.getPagesWithoutEmbedding("test-project");
      expect(without).toHaveLength(1);
      expect(without[0].path).toBe("facts/without.md");
    });

    it("deletePage deve remover embeddings junto (FK)", () => {
      const page = makePage();
      store.insertPage(page);
      store.updatePageEmbedding(page.id, makeEmbedding());

      store.deletePage(page.project_id, page.path);
      // Não deve ter embeddings órfãos
      expect(store.getPagesWithEmbeddings(page.project_id)).toHaveLength(0);
    });
  });

  // ── FTS5 Search ───────────────────────────────────────────────────

  describe("searchPagesFts", () => {
    it("deve buscar por texto no body", () => {
      store.insertPage(makePage({ path: "facts/a.md", body: "docker compose para deploy" }));
      store.insertPage(makePage({ path: "facts/b.md", body: "usa kubernetes" }));

      const results = store.searchPagesFts("docker", "test-project");
      expect(results).toHaveLength(1);
      expect(results[0].page.path).toBe("facts/a.md");
      expect(results[0].strategy).toBe("fts5");
    });

    it("deve filtrar por project_id", () => {
      store.insertPage(makePage({ project_id: "proj-a", path: "facts/a.md", body: "docker" }));
      store.insertPage(makePage({ project_id: "proj-b", path: "facts/b.md", body: "docker" }));

      const resultsA = store.searchPagesFts("docker", "proj-a");
      expect(resultsA).toHaveLength(1);
    });

    it("deve excluir páginas superseded da busca", () => {
      store.insertPage(makePage({ path: "facts/active.md", body: "docker compose" }));
      store.insertPage(makePage({ path: "facts/dead.md", body: "docker swarm", status: "superseded" }));

      const results = store.searchPagesFts("docker", "test-project");
      expect(results).toHaveLength(1);
      expect(results[0].page.path).toBe("facts/active.md");
    });

    it("deve retornar snippet do body", () => {
      store.insertPage(makePage({ body: "A".repeat(500) }));
      const results = store.searchPagesFts("A", "test-project");
      expect(results[0].snippet.length).toBeLessThanOrEqual(300);
    });

    it("deve respeitar limit", () => {
      for (let i = 0; i < 5; i++) {
        store.insertPage(makePage({ path: `facts/${i}.md`, body: "docker" }));
      }
      const results = store.searchPagesFts("docker", "test-project", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Observations ─────────────────────────────────────────────────

  describe("observations", () => {
    it("deve inserir e recuperar observações", () => {
      const obs = makeObservation();
      store.insertObservation(obs);
      const results = store.getObservations("test-project");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(obs.id);
    });

    it("deve inserir em batch", () => {
      store.insertObservationsBatch([makeObservation(), makeObservation()]);
      expect(store.getObservations("test-project")).toHaveLength(2);
    });

    it("getPendingObservations deve filtrar não extraídas", () => {
      store.insertObservation(makeObservation({ extracted: false }));
      store.insertObservation(makeObservation({ extracted: true }));
      expect(store.getPendingObservations("test-project")).toHaveLength(1);
    });

    it("markExtracted deve marcar como extraída", () => {
      const obs = makeObservation();
      store.insertObservation(obs);
      store.markExtracted([obs.id]);
      expect(store.getPendingObservations("test-project")).toHaveLength(0);
    });

    it("cleanupExpired deve remover TTL expirado", () => {
      const past = Date.now() - 1000;
      store.insertObservation(makeObservation({ ttl: past }));
      store.insertObservation(makeObservation({ ttl: Date.now() + 999999 }));

      const deleted = store.cleanupExpired(Date.now());
      expect(deleted).toBe(1);
      expect(store.countObservations()).toBe(1);
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────

  describe("stats", () => {
    it("countPages deve contar apenas ativas", () => {
      store.insertPage(makePage({ path: "facts/a.md", status: "active" }));
      store.insertPage(makePage({ path: "facts/b.md", status: "superseded" }));
      expect(store.countPages()).toBe(1);
    });

    it("countObservations deve contar total", () => {
      store.insertObservation(makeObservation());
      store.insertObservation(makeObservation());
      expect(store.countObservations()).toBe(2);
    });

    it("countPendingExtraction deve contar não extraídas", () => {
      store.insertObservation(makeObservation({ extracted: false }));
      store.insertObservation(makeObservation({ extracted: false }));
      store.insertObservation(makeObservation({ extracted: true }));
      expect(store.countPendingExtraction()).toBe(2);
    });
  });
});
