/**
 * Testes do SweepConsolidator (N2 background sweep).
 *
 * Cobre: agrupamento por tool_name, extração batch, decay, pruning, TTL cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SweepConsolidator, type SweepConfig } from "../../consolidate/sweep";
import type { IStorage } from "../../storage/index";
import type { RawObservation, Memory } from "../../types";

// ── Helpers ────────────────────────────────────────────────────────────

function makeObs(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    id: `obs-${Math.random().toString(36).slice(2, 8)}`,
    session_id: "sess-1",
    project_id: "proj-1",
    timestamp: Date.now(),
    type: "tool_result",
    tool_name: "bash",
    input_json: null,
    outcome: "success",
    content_preview: "x".repeat(100),
    error_preview: null,
    file_paths: [],
    ttl: Date.now() + 7 * 24 * 60 * 60 * 1000,
    extracted: false,
    ...overrides,
  };
}

function makeMem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    text: "Some memory text",
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
    content_hash: "abc123",
    ...overrides,
  };
}

function createMockStorage(
  overrides: Partial<Record<keyof IStorage, unknown>> = {},
): IStorage {
  const memories: Memory[] = [];
  const observations: RawObservation[] = [];
  return {
    open: vi.fn(),
    close: vi.fn(),
    insertMemory: vi.fn((m: Memory) => {
      memories.push(m);
    }),
    getMemory: vi.fn(() => null),
    getMemoriesByProject: vi.fn(() => [...memories]),
    getMemoryByHash: vi.fn(() => null),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn((id: string) => {
      const idx = memories.findIndex((m) => m.id === id);
      if (idx >= 0) memories.splice(idx, 1);
    }),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn((obs: RawObservation[]) => {
      observations.push(...obs);
    }),
    getObservations: vi.fn(() => [...observations]),
    getPendingObservations: vi.fn(() => observations.filter((o) => !o.extracted)),
    markExtracted: vi.fn((ids: string[]) => {
      for (const id of ids) {
        const obs = observations.find((o) => o.id === id);
        if (obs) obs.extracted = true;
      }
    }),
    cleanupExpired: vi.fn(() => 0),
    searchFts: vi.fn(() => []),
    countMemories: vi.fn(() => memories.length),
    countObservations: vi.fn(() => observations.length),
    countPendingExtraction: vi.fn(() => observations.filter((o) => !o.extracted).length),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(() => []),
    ...overrides,
  } as IStorage;
}

/** Mock mínimo de LlmExtractor — só precisa de extractBatch */
function createMockLlmExtractor() {
  return {
    extractBatch: vi.fn(),
    enqueue: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as import("../../extract/llm-extractor").LlmExtractor;
}

function baseSweepConfig(overrides: Partial<SweepConfig> = {}): SweepConfig {
  return {
    intervalMs: 30 * 60 * 1000,
    observationThreshold: 50,
    minGroupSize: 3,
    decayEnabled: false,
    decayDays: 7,
    decayFactor: 0.9,
    pruningEnabled: false,
    pruningConfidenceThreshold: 0.1,
    pruningAgeDays: 30,
    ...overrides,
  };
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("SweepConsolidator", () => {
  let storage: IStorage;
  let llmExtractor: ReturnType<typeof createMockLlmExtractor>;
  let sweep: SweepConsolidator;

  beforeEach(() => {
    storage = createMockStorage();
    llmExtractor = createMockLlmExtractor();
  });

  afterEach(() => {
    sweep?.stop();
    vi.restoreAllMocks();
  });

  function createSweep(cfg: Partial<SweepConfig> = {}): SweepConsolidator {
    sweep = new SweepConsolidator(
      storage,
      llmExtractor,
      "proj-1",
      baseSweepConfig(cfg),
    );
    return sweep;
  }

  // ── Grouping ──────────────────────────────────────────────────────

  describe("agrupamento por tool_name", () => {
    it("deve agrupar observações por tool_name e extrair grupos ≥ minGroupSize", async () => {
      createSweep({ minGroupSize: 2 });
      // 3 bash, 2 edit, 1 read → só bash atinge threshold (3≥2) e edit (2≥2)
      const obs = [
        makeObs({ id: "a", tool_name: "bash" }),
        makeObs({ id: "b", tool_name: "bash" }),
        makeObs({ id: "c", tool_name: "bash" }),
        makeObs({ id: "d", tool_name: "edit" }),
        makeObs({ id: "e", tool_name: "edit" }),
        makeObs({ id: "f", tool_name: "read" }),
      ];
      // Injeta no storage interno
      (storage.insertObservationsBatch as ReturnType<typeof vi.fn>)(obs);

      await sweep.run();

      // extractBatch deve ser chamado 2x: grupo bash e grupo edit
      expect(llmExtractor.extractBatch).toHaveBeenCalledTimes(2);
    });

    it("não deve extrair grupos abaixo do minGroupSize", async () => {
      createSweep({ minGroupSize: 5 });
      const obs = [
        makeObs({ id: "a", tool_name: "bash" }),
        makeObs({ id: "b", tool_name: "bash" }),
        makeObs({ id: "c", tool_name: "edit" }),
      ];
      (storage.insertObservationsBatch as ReturnType<typeof vi.fn>)(obs);

      await sweep.run();

      expect(llmExtractor.extractBatch).not.toHaveBeenCalled();
    });

    it("não deve quebrar com zero observações pendentes", async () => {
      createSweep();
      await sweep.run();
      expect(llmExtractor.extractBatch).not.toHaveBeenCalled();
    });

    it("deve usar 'unknown' como key para tool_name nulo", async () => {
      createSweep({ minGroupSize: 2 });
      const obs = [
        makeObs({ id: "a", tool_name: null }),
        makeObs({ id: "b", tool_name: null }),
        makeObs({ id: "c", tool_name: null }),
      ];
      (storage.insertObservationsBatch as ReturnType<typeof vi.fn>)(obs);

      await sweep.run();

      expect(llmExtractor.extractBatch).toHaveBeenCalledTimes(1);
      const batch = (llmExtractor.extractBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as RawObservation[];
      expect(batch).toHaveLength(3);
    });
  });

  // ── Decay ─────────────────────────────────────────────────────────

  describe("decay de confidence", () => {
    it("deve reduzir confidence de memórias antigas não acessadas", async () => {
      createSweep({ decayEnabled: true, decayDays: 5, decayFactor: 0.9 });
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 dias atrás
      const mem = makeMem({
        id: "old-mem",
        confidence: 0.8,
        last_accessed: oldDate,
        timestamp: oldDate,
      });
      // Insere no storage
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.updateMemory).toHaveBeenCalled();
      const updated = (storage.updateMemory as ReturnType<typeof vi.fn>).mock.calls[0][0] as Memory;
      expect(updated.confidence).toBeCloseTo(0.8 * 0.9, 5);
    });

    it("NÃO deve reduzir confidence de memórias recentes", async () => {
      createSweep({ decayEnabled: true, decayDays: 5, decayFactor: 0.9 });
      const mem = makeMem({
        confidence: 0.8,
        last_accessed: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 dia atrás
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.updateMemory).not.toHaveBeenCalled();
    });

    it("NÃO deve aplicar decay em memórias pinadas", async () => {
      createSweep({ decayEnabled: true, decayDays: 5, decayFactor: 0.9 });
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const mem = makeMem({
        confidence: 0.8,
        last_accessed: oldDate,
        pinned: true,
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.updateMemory).not.toHaveBeenCalled();
    });

    it("NÃO deve aplicar decay em memórias superseded", async () => {
      createSweep({ decayEnabled: true, decayDays: 5, decayFactor: 0.9 });
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const mem = makeMem({
        confidence: 0.8,
        last_accessed: oldDate,
        superseded_by: "other-mem",
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.updateMemory).not.toHaveBeenCalled();
    });

    it("deve capar confidence mínima em 0", async () => {
      createSweep({ decayEnabled: true, decayDays: 5, decayFactor: 0.9 });
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const mem = makeMem({
        confidence: 0.001, // 0.001 * 0.9 = 0.0009 → Math.max(0, ...) = 0.0009 (>0)
        last_accessed: oldDate,
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      const updated = (storage.updateMemory as ReturnType<typeof vi.fn>).mock.calls[0][0] as Memory;
      // Math.max(0, 0.0009) = 0.0009. Cap real é >= 0, não necessariamente 0 exato.
      expect(updated.confidence).toBeGreaterThanOrEqual(0);
      expect(updated.confidence).toBeLessThan(0.01);
    });
  });

  // ── Pruning ───────────────────────────────────────────────────────

  describe("pruning de memórias", () => {
    it("deve deletar memórias com confidence < threshold e idade > pruningAgeDays", async () => {
      createSweep({
        pruningEnabled: true,
        pruningConfidenceThreshold: 0.1,
        pruningAgeDays: 30,
      });
      const oldDate = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 dias atrás
      const mem = makeMem({
        id: "prune-me",
        confidence: 0.05,
        last_accessed: oldDate,
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.deleteMemory).toHaveBeenCalledWith("prune-me");
    });

    it("NÃO deve deletar memórias com confidence acima do threshold", async () => {
      createSweep({
        pruningEnabled: true,
        pruningConfidenceThreshold: 0.1,
        pruningAgeDays: 30,
      });
      const oldDate = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const mem = makeMem({
        confidence: 0.15, // acima de 0.1
        last_accessed: oldDate,
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.deleteMemory).not.toHaveBeenCalled();
    });

    it("NÃO deve deletar memórias recentes mesmo com confidence baixa", async () => {
      createSweep({
        pruningEnabled: true,
        pruningConfidenceThreshold: 0.1,
        pruningAgeDays: 30,
      });
      const mem = makeMem({
        confidence: 0.05,
        last_accessed: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 dia atrás
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.deleteMemory).not.toHaveBeenCalled();
    });

    it("NÃO deve deletar memórias pinadas", async () => {
      createSweep({
        pruningEnabled: true,
        pruningConfidenceThreshold: 0.1,
        pruningAgeDays: 30,
      });
      const oldDate = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const mem = makeMem({
        confidence: 0.05,
        last_accessed: oldDate,
        pinned: true,
      });
      (storage.getMemoriesByProject as ReturnType<typeof vi.fn>).mockReturnValue([mem]);

      await sweep.run();

      expect(storage.deleteMemory).not.toHaveBeenCalled();
    });
  });

  // ── TTL Cleanup ───────────────────────────────────────────────────

  describe("limpeza de TTL", () => {
    it("deve chamar storage.cleanupExpired com timestamp atual", async () => {
      createSweep();
      const before = Date.now();

      await sweep.run();

      expect(storage.cleanupExpired).toHaveBeenCalled();
      const calledWith = (storage.cleanupExpired as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;
      // Deve ser ≥ before e ≤ after (com tolerância de 100ms)
      expect(calledWith).toBeGreaterThanOrEqual(before);
      expect(calledWith).toBeLessThanOrEqual(Date.now() + 100);
    });
  });

  // ── Schedule / Stop ───────────────────────────────────────────────

  describe("schedule / stop", () => {
    it("schedule deve iniciar timer; stop deve pará-lo", () => {
      createSweep({ intervalMs: 1000 });
      sweep.schedule();
      // @ts-expect-error acesso privado
      expect(sweep.timer).not.toBeNull();

      sweep.stop();
      // @ts-expect-error acesso privado
      expect(sweep.timer).toBeNull();
    });

    it("schedule duplo não deve criar múltiplos timers", () => {
      createSweep({ intervalMs: 1000 });
      sweep.schedule();
      // @ts-expect-error
      const firstTimer = sweep.timer;
      sweep.schedule();
      // @ts-expect-error
      expect(sweep.timer).toBe(firstTimer); // mesmo timer
    });
  });

  // ── onSweep callback ──────────────────────────────────────────────

  describe("onSweep callback", () => {
    it("deve disparar callback após sweep bem-sucedido", async () => {
      let called = false;
      sweep = new SweepConsolidator(
        storage,
        llmExtractor,
        "proj-1",
        baseSweepConfig(),
        () => {
          called = true;
        },
      );

      await sweep.run();
      expect(called).toBe(true);
    });

    it("NÃO deve disparar callback se sweep lança erro", async () => {
      // Força storage a lançar erro em getPendingObservations
      const badStorage = createMockStorage({
        getPendingObservations: vi.fn(() => {
          throw new Error("boom");
        }),
      });

      let called = false;
      sweep = new SweepConsolidator(
        badStorage,
        llmExtractor,
        "proj-1",
        baseSweepConfig(),
        () => {
          called = true;
        },
      );

      await sweep.run();
      expect(called).toBe(false);
    });
  });

  // ── run concorrente ───────────────────────────────────────────────

  describe("proteção contra run concorrente", () => {
    it("não deve executar sweep enquanto outro está rodando", () => {
      createSweep();

      // Simula running=true manualmente
      (sweep as unknown as { running: boolean }).running = true;

      // Segundo run deve ser barrado e retornar imediatamente
      const p = sweep.run();

      // cleanupExpired NÃO deve ser chamado (run barrado pelo guard)
      expect(storage.cleanupExpired).not.toHaveBeenCalled();

      // Deve retornar promise resolvida (undefined wrapped)
      expect(p).toBeInstanceOf(Promise);
    });
  });
});
