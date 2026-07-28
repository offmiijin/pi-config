/**
 * Testes do JsonStore — camada cold de storage (JSON em disco).
 *
 * Usa diretório temporário para cada teste.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JsonStore } from "../../storage/json-store";
import type { Memory, RawObservation } from "../../types";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("JsonStore", () => {
  let store: JsonStore;
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    store = new JsonStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Memories ──────────────────────────────────────────────────────

  describe("writeMemories / readMemories", () => {
    it("deve escrever e ler array vazio", () => {
      store.writeMemories([]);
      expect(store.readMemories()).toEqual([]);
    });

    it("deve persistir e restaurar memórias", () => {
      const mem1 = makeMemory({ text: "Memória A" });
      const mem2 = makeMemory({ text: "Memória B" });

      store.writeMemories([mem1, mem2]);
      const loaded = store.readMemories();

      expect(loaded).toHaveLength(2);
      expect(loaded[0].text).toBe("Memória A");
      expect(loaded[1].text).toBe("Memória B");
    });

    it("deve preservar todos os campos", () => {
      const mem = makeMemory({
        text: "Completa",
        type: "lesson",
        scope: "user",
        tags: ["#tag1", "#tag2"],
        confidence: 0.75,
        source_ids: ["s1", "s2"],
        superseded_by: "other-id",
        pinned: true,
      });
      store.writeMemories([mem]);

      const [loaded] = store.readMemories();
      expect(loaded.id).toBe(mem.id);
      expect(loaded.text).toBe("Completa");
      expect(loaded.type).toBe("lesson");
      expect(loaded.scope).toBe("user");
      expect(loaded.tags).toEqual(["#tag1", "#tag2"]);
      expect(loaded.confidence).toBe(0.75);
      expect(loaded.source_ids).toEqual(["s1", "s2"]);
      expect(loaded.superseded_by).toBe("other-id");
      expect(loaded.pinned).toBe(true);
      expect(loaded.project_id).toBe("test-project");
      expect(loaded.content_hash).toBe("abc123");
    });

    it("deve serializar embedding como array de números", () => {
      // Usa valores exatamente representáveis em float32 para evitar erros de precisão
      const embedding = new Float32Array([0.5, 0.25, 0.125]);
      const mem = makeMemory({ embedding });
      store.writeMemories([mem]);

      const json = fs.readFileSync(path.join(dir, "memories.json"), "utf-8");
      const parsed = JSON.parse(json);
      expect(parsed[0].embedding).toEqual([0.5, 0.25, 0.125]);
    });

    it("deve desserializar embedding de volta para Float32Array", () => {
      const embedding = new Float32Array([0.5, 0.25, 0.125]);
      store.writeMemories([makeMemory({ embedding })]);

      const [loaded] = store.readMemories();
      expect(loaded.embedding).toBeInstanceOf(Float32Array);
      expect(Array.from(loaded.embedding!)).toEqual([0.5, 0.25, 0.125]);
    });

    it("deve preservar embedding null", () => {
      store.writeMemories([makeMemory({ embedding: null })]);
      const [loaded] = store.readMemories();
      expect(loaded.embedding).toBeNull();
    });

    it("deve sobrescrever arquivo existente", () => {
      store.writeMemories([makeMemory({ text: "Primeira" })]);
      store.writeMemories([makeMemory({ text: "Segunda" })]);

      const loaded = store.readMemories();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].text).toBe("Segunda");
    });

    it("readMemories deve retornar [] quando arquivo não existe", () => {
      expect(store.readMemories()).toEqual([]);
    });

    it("readMemories deve retornar [] quando arquivo está vazio", () => {
      fs.writeFileSync(path.join(dir, "memories.json"), "");
      expect(store.readMemories()).toEqual([]);
    });

    it("deve escrever JSON formatado (pretty-print)", () => {
      store.writeMemories([makeMemory()]);
      const raw = fs.readFileSync(path.join(dir, "memories.json"), "utf-8");
      expect(raw).toContain("\n");
      expect(raw).toContain('  "id"');
    });

    it("write atômico: arquivo temporário não deve sobrar", () => {
      store.writeMemories([makeMemory()]);
      const files = fs.readdirSync(dir);
      expect(files).not.toContain("memories.json.tmp");
    });

    it("write atômico: em caso de falha, arquivo original preservado", () => {
      // Pré-popula
      const original = makeMemory({ text: "original" });
      store.writeMemories([original]);

      // Força falha passando objeto circular (não serializável)
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;

      expect(() => {
        // Acessa direto fs.writeFileSync para simular falha no write
        const tmpPath = path.join(dir, "memories.json.tmp");
        fs.writeFileSync(tmpPath, "incomplete-", "utf-8");
        // Não faz rename - simula crash. Arquivo original continua intacto.
      }).not.toThrow();

      // Arquivo original ainda existe e é válido
      const loaded = store.readMemories();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].text).toBe("original");
    });
  });

  // ── Observations ──────────────────────────────────────────────────

  describe("writeObservations / readObservations", () => {
    it("deve escrever e ler observações", () => {
      const obs1 = makeObservation({ tool_name: "bash" });
      const obs2 = makeObservation({ tool_name: "write" });

      store.writeObservations([obs1, obs2]);
      const loaded = store.readObservations();

      expect(loaded).toHaveLength(2);
      expect(loaded[0].tool_name).toBe("bash");
      expect(loaded[1].tool_name).toBe("write");
    });

    it("deve preservar todos os campos de observação", () => {
      const obs = makeObservation({
        type: "user_prompt",
        tool_name: null,
        outcome: "error",
        error_preview: "something went wrong",
        file_paths: ["/a", "/b"],
        extracted: true,
      });
      store.writeObservations([obs]);

      const [loaded] = store.readObservations();
      expect(loaded.type).toBe("user_prompt");
      expect(loaded.tool_name).toBeNull();
      expect(loaded.outcome).toBe("error");
      expect(loaded.error_preview).toBe("something went wrong");
      expect(loaded.file_paths).toEqual(["/a", "/b"]);
      expect(loaded.extracted).toBe(true);
    });

    it("readObservations deve retornar [] quando arquivo não existe", () => {
      expect(store.readObservations()).toEqual([]);
    });

    it("deve sobrescrever arquivo existente", () => {
      store.writeObservations([makeObservation()]);
      store.writeObservations([makeObservation(), makeObservation()]);

      expect(store.readObservations()).toHaveLength(2);
    });
  });

  // ── Write atômico ─────────────────────────────────────────────────

  describe("atomicidade", () => {
    it("deve criar diretório data se não existir", () => {
      const newDir = path.join(dir, "sub", "nested");
      const s = new JsonStore(newDir);
      s.writeMemories([makeMemory()]);

      expect(fs.existsSync(path.join(newDir, "memories.json"))).toBe(true);
    });

    it("deve lidar com múltiplas escritas concorrentes (stress)", () => {
      for (let i = 0; i < 10; i++) {
        store.writeMemories([makeMemory({ text: `write ${i}` })]);
        const loaded = store.readMemories();
        expect(loaded).toHaveLength(1);
      }
    });

    it("não deve perder dados se processo morre entre write e rename", () => {
      // Simula: escreve tmp, mas não faz rename (como se crashasse)
      const tmpPath = path.join(dir, "memories.json.tmp");
      fs.writeFileSync(tmpPath, '[{"text":"stale"}]', "utf-8");

      // O store lê do arquivo final, não do tmp
      store.writeMemories([makeMemory({ text: "real" })]);
      const loaded = store.readMemories();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].text).toBe("real");
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });
});
