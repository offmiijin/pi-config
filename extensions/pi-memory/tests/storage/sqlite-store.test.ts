/**
 * Testes do SqliteStore — camada warm de storage.
 *
 * Usa banco em memória (:memory:) para isolamento e velocidade.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStore } from "../../storage/sqlite-store";
import type { Memory, RawObservation } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: randomUUID(),
    text: "Usa pnpm em todos os projetos",
    embedding: null,
    type: "preference",
    scope: "project",
    tags: ["#preference", "#pnpm"],
    confidence: 0.8,
    timestamp: now,
    last_accessed: now,
    access_count: 1,
    source_ids: [randomUUID()],
    superseded_by: null,
    pinned: false,
    project_id: "test-project",
    content_hash: "abc123",
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
    // Fechar e reabrir não deve lançar erro
    store.close();
    store = new SqliteStore(":memory:");
    expect(store.countMemories()).toBe(0);
  });

  // ── Memory CRUD ───────────────────────────────────────────────────

  describe("insertMemory", () => {
    it("deve inserir uma memória", () => {
      const mem = makeMemory();
      store.insertMemory(mem);
      expect(store.countMemories()).toBe(1);
    });

    it("deve persistir todos os campos", () => {
      const mem = makeMemory({
        text: "Testes usam vitest",
        type: "pattern",
        scope: "project",
        tags: ["#pattern", "#vitest"],
        confidence: 0.9,
        pinned: true,
      });
      store.insertMemory(mem);

      const retrieved = store.getMemory(mem.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.text).toBe("Testes usam vitest");
      expect(retrieved!.type).toBe("pattern");
      expect(retrieved!.scope).toBe("project");
      expect(retrieved!.tags).toEqual(["#pattern", "#vitest"]);
      expect(retrieved!.confidence).toBe(0.9);
      expect(retrieved!.pinned).toBe(true);
      expect(retrieved!.project_id).toBe("test-project");
    });

    it("deve serializar embedding Float32Array para BLOB", () => {
      // Usa valores exatamente representáveis em float32
      const embedding = new Float32Array([0.5, 0.25, 0.125, -1.0]);
      const mem = makeMemory({ embedding });
      store.insertMemory(mem);

      const retrieved = store.getMemory(mem.id);
      expect(retrieved!.embedding).toBeInstanceOf(Float32Array);
      expect(Array.from(retrieved!.embedding!)).toEqual([0.5, 0.25, 0.125, -1.0]);
    });

    it("deve aceitar embedding null", () => {
      const mem = makeMemory({ embedding: null });
      store.insertMemory(mem);
      const retrieved = store.getMemory(mem.id);
      expect(retrieved!.embedding).toBeNull();
    });

    it("deve serializar arrays como JSON", () => {
      const mem = makeMemory({
        tags: ["#a", "#b"],
        source_ids: ["id1", "id2"],
      });
      store.insertMemory(mem);

      const retrieved = store.getMemory(mem.id);
      expect(retrieved!.tags).toEqual(["#a", "#b"]);
      expect(retrieved!.source_ids).toEqual(["id1", "id2"]);
    });

    it("deve lançar ao inserir ID duplicado", () => {
      const mem = makeMemory();
      store.insertMemory(mem);
      expect(() => store.insertMemory(mem)).toThrow();
    });
  });

  describe("getMemory", () => {
    it("deve retornar null para id inexistente", () => {
      expect(store.getMemory("nonexistent")).toBeNull();
    });

    it("deve retornar a memória correta", () => {
      const mem1 = makeMemory({ text: "A" });
      const mem2 = makeMemory({ text: "B" });
      store.insertMemory(mem1);
      store.insertMemory(mem2);

      expect(store.getMemory(mem1.id)!.text).toBe("A");
      expect(store.getMemory(mem2.id)!.text).toBe("B");
    });
  });

  describe("getMemoriesByProject", () => {
    it("deve filtrar por project_id", () => {
      const projA = makeMemory({ project_id: "proj-a", text: "A" });
      const projB = makeMemory({ project_id: "proj-b", text: "B" });
      store.insertMemory(projA);
      store.insertMemory(projB);

      const results = store.getMemoriesByProject("proj-a");
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("A");
    });

    it("deve retornar array vazio para projeto sem memórias", () => {
      expect(store.getMemoriesByProject("vazio")).toEqual([]);
    });

    it("deve ordenar por timestamp DESC", () => {
      const older = makeMemory({ timestamp: 1000, text: "older" });
      const newer = makeMemory({ timestamp: 2000, text: "newer" });
      store.insertMemory(older);
      store.insertMemory(newer);

      const results = store.getMemoriesByProject("test-project");
      expect(results[0].text).toBe("newer");
      expect(results[1].text).toBe("older");
    });
  });

  describe("getMemoryByHash", () => {
    it("deve encontrar por hash no projeto correto", () => {
      const mem = makeMemory({ content_hash: "hash123" });
      store.insertMemory(mem);

      const found = store.getMemoryByHash("test-project", "hash123");
      expect(found).not.toBeNull();
      expect(found!.content_hash).toBe("hash123");
    });

    it("deve retornar null para hash de projeto diferente", () => {
      const mem = makeMemory({ project_id: "proj-a", content_hash: "hash123" });
      store.insertMemory(mem);

      expect(store.getMemoryByHash("proj-b", "hash123")).toBeNull();
    });

    it("deve retornar null para hash inexistente", () => {
      expect(store.getMemoryByHash("test-project", "no-such-hash")).toBeNull();
    });
  });

  describe("updateMemory", () => {
    it("deve atualizar campos", () => {
      const mem = makeMemory();
      store.insertMemory(mem);

      const updated = { ...mem, text: "Texto atualizado", confidence: 1.0 };
      store.updateMemory(updated);

      const retrieved = store.getMemory(mem.id);
      expect(retrieved!.text).toBe("Texto atualizado");
      expect(retrieved!.confidence).toBe(1.0);
    });

    it("deve atualizar embedding", () => {
      const mem = makeMemory({ embedding: null });
      store.insertMemory(mem);

      const newEmbedding = new Float32Array([0.5, 0.25]);
      store.updateMemory({ ...mem, embedding: newEmbedding });

      const retrieved = store.getMemory(mem.id);
      expect(Array.from(retrieved!.embedding!)).toEqual([0.5, 0.25]);
    });
  });

  describe("deleteMemory", () => {
    it("deve remover memória", () => {
      const mem = makeMemory();
      store.insertMemory(mem);
      expect(store.countMemories()).toBe(1);

      store.deleteMemory(mem.id);
      expect(store.countMemories()).toBe(0);
      expect(store.getMemory(mem.id)).toBeNull();
    });

    it("deve ser idempotente (não lança ao deletar inexistente)", () => {
      expect(() => store.deleteMemory("nonexistent")).not.toThrow();
    });
  });

  // ── Observation CRUD ──────────────────────────────────────────────

  describe("insertObservation", () => {
    it("deve inserir uma observação", () => {
      const obs = makeObservation();
      store.insertObservation(obs);
      expect(store.countObservations()).toBe(1);
    });

    it("deve persistir todos os campos", () => {
      const obs = makeObservation({
        tool_name: "write",
        outcome: "error",
        error_preview: "Permission denied",
        file_paths: ["/src/auth.ts"],
        extracted: true,
      });
      store.insertObservation(obs);

      const rows = store.getObservations("test-project", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe("write");
      expect(rows[0].outcome).toBe("error");
      expect(rows[0].error_preview).toBe("Permission denied");
      expect(rows[0].file_paths).toEqual(["/src/auth.ts"]);
      expect(rows[0].extracted).toBe(true);
    });

    it("deve aceitar tool_name null", () => {
      const obs = makeObservation({ tool_name: null });
      store.insertObservation(obs);
      const rows = store.getObservations("test-project", 1);
      expect(rows[0].tool_name).toBeNull();
    });
  });

  describe("insertObservationsBatch", () => {
    it("deve inserir múltiplas observações em transação", () => {
      const obs1 = makeObservation();
      const obs2 = makeObservation();
      const obs3 = makeObservation();

      store.insertObservationsBatch([obs1, obs2, obs3]);
      expect(store.countObservations()).toBe(3);
    });

    it("deve fazer rollback em caso de erro (atomicidade)", () => {
      const obs1 = makeObservation();
      const duplicate = makeObservation(); // mesmo id de obs1

      // Força duplicata no batch
      const dupId = obs1.id;
      const obs2 = makeObservation({ id: dupId });

      store.insertObservation(obs1);
      expect(() => store.insertObservationsBatch([obs2, makeObservation()])).toThrow();
      // obs1 permanece, outras do batch não foram inseridas
      expect(store.countObservations()).toBe(1);
    });
  });

  describe("getObservations", () => {
    it("deve filtrar por project_id", () => {
      const obsA = makeObservation({ project_id: "proj-a" });
      const obsB = makeObservation({ project_id: "proj-b" });
      store.insertObservation(obsA);
      store.insertObservation(obsB);

      expect(store.getObservations("proj-a")).toHaveLength(1);
      expect(store.getObservations("proj-b")).toHaveLength(1);
    });

    it("deve respeitar limit", () => {
      for (let i = 0; i < 10; i++) {
        store.insertObservation(makeObservation());
      }
      expect(store.getObservations("test-project", 3)).toHaveLength(3);
    });
  });

  describe("getPendingObservations", () => {
    it("deve retornar apenas observações não extraídas", () => {
      const pending = makeObservation({ extracted: false });
      const extracted = makeObservation({ extracted: true });
      store.insertObservation(pending);
      store.insertObservation(extracted);

      const results = store.getPendingObservations("test-project");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(pending.id);
    });
  });

  describe("markExtracted", () => {
    it("deve marcar observações como extraídas", () => {
      const obs = makeObservation({ extracted: false });
      store.insertObservation(obs);

      store.markExtracted([obs.id]);

      const pending = store.getPendingObservations("test-project");
      expect(pending).toHaveLength(0);
    });
  });

  describe("cleanupExpired", () => {
    it("deve deletar observações com TTL expirado", () => {
      const expired = makeObservation({ ttl: 1000 });
      const valid = makeObservation({ ttl: Date.now() + 86400000 });
      store.insertObservation(expired);
      store.insertObservation(valid);

      const deleted = store.cleanupExpired(Date.now());
      expect(deleted).toBe(1);
      expect(store.countObservations()).toBe(1);
    });

    it("deve retornar 0 quando nada expirou", () => {
      store.insertObservation(makeObservation({ ttl: Date.now() + 86400000 }));
      expect(store.cleanupExpired(Date.now())).toBe(0);
    });
  });

  // ── FTS5 Search ───────────────────────────────────────────────────

  describe("searchFts", () => {
    it("deve buscar por texto via FTS5", () => {
      const mem = makeMemory({
        text: "Payment API segue hexagonal architecture",
        type: "decision",
      });
      store.insertMemory(mem);

      const results = store.searchFts("hexagonal", "test-project");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.id).toBe(mem.id);
    });

    it("deve filtrar por project_id", () => {
      const projA = makeMemory({ project_id: "proj-a", text: "docker compose" });
      const projB = makeMemory({ project_id: "proj-b", text: "docker compose" });
      store.insertMemory(projA);
      store.insertMemory(projB);

      const results = store.searchFts("docker", "proj-a");
      expect(results).toHaveLength(1);
      expect(results[0].memory.project_id).toBe("proj-a");
    });

    it("deve retornar array vazio quando não há match", () => {
      store.insertMemory(makeMemory({ text: "usa pnpm" }));
      expect(store.searchFts("xyznotfound", "test-project")).toEqual([]);
    });

    it("deve respeitar limit", () => {
      for (let i = 0; i < 5; i++) {
        store.insertMemory(makeMemory({ text: `docker deploy ${i}` }));
      }
      expect(store.searchFts("docker", "test-project", 3)).toHaveLength(3);
    });

    it("deve retornar bm25_score", () => {
      store.insertMemory(makeMemory({ text: "docker compose para deploy local" }));
      const results = store.searchFts("docker", "test-project");
      expect(results[0].bm25Score).toBeDefined();
      expect(typeof results[0].bm25Score).toBe("number");
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────

  describe("counters", () => {
    it("countMemories deve refletir inserts e deletes", () => {
      expect(store.countMemories()).toBe(0);

      const m = makeMemory();
      store.insertMemory(m);
      expect(store.countMemories()).toBe(1);

      store.deleteMemory(m.id);
      expect(store.countMemories()).toBe(0);
    });

    it("countObservations deve refletir inserts", () => {
      expect(store.countObservations()).toBe(0);
      store.insertObservation(makeObservation());
      expect(store.countObservations()).toBe(1);
    });

    it("countPendingExtraction deve contar apenas não-extraídos", () => {
      store.insertObservation(makeObservation({ extracted: false }));
      store.insertObservation(makeObservation({ extracted: false }));
      store.insertObservation(makeObservation({ extracted: true }));
      expect(store.countPendingExtraction()).toBe(2);
    });
  });

  // ── FTS5 Trigger ──────────────────────────────────────────────────

  describe("FTS5 triggers", () => {
    it("deve sincronizar FTS5 no INSERT", () => {
      const mem = makeMemory({ text: "testando trigger insert" });
      store.insertMemory(mem);

      const results = store.searchFts("trigger", "test-project");
      expect(results).toHaveLength(1);
    });

    it("deve sincronizar FTS5 no UPDATE", () => {
      const mem = makeMemory({ text: "texto original" });
      store.insertMemory(mem);

      // Antes do update, "atualizado" não existe
      expect(store.searchFts("atualizado", "test-project")).toHaveLength(0);

      store.updateMemory({ ...mem, text: "texto atualizado" });

      // Depois do update, deve achar e não achar o antigo
      expect(store.searchFts("atualizado", "test-project")).toHaveLength(1);
      expect(store.searchFts("original", "test-project")).toHaveLength(0);
    });

    it("deve sincronizar FTS5 no DELETE", () => {
      const mem = makeMemory({ text: "para ser deletado" });
      store.insertMemory(mem);
      expect(store.searchFts("deletado", "test-project")).toHaveLength(1);

      store.deleteMemory(mem.id);
      expect(store.searchFts("deletado", "test-project")).toHaveLength(0);
    });
  });
});
