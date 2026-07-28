/**
 * Testes do ObservationBuffer.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ObservationBuffer } from "../../capture/buffer";
import type { IStorage } from "../../storage/index";
import type { RawObservation } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

function makeObs(overrides: Partial<RawObservation> = {}): RawObservation {
  const now = Date.now();
  return {
    id: randomUUID(),
    session_id: "session-1",
    project_id: "test-project",
    timestamp: now,
    type: "tool_result",
    tool_name: "bash",
    input_json: JSON.stringify({ command: "ls" }),
    outcome: "success",
    content_preview: "file1\nfile2\n",
    error_preview: null,
    file_paths: [],
    ttl: now + 604800000,
    extracted: false,
    ...overrides,
  };
}

function createMockStorage(): IStorage {
  const observations: RawObservation[] = [];
  return {
    open: vi.fn(),
    close: vi.fn(),
    insertMemory: vi.fn(),
    getMemory: vi.fn(() => null),
    getMemoriesByProject: vi.fn(() => []),
    getMemoryByHash: vi.fn(() => null),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    insertObservation: vi.fn((obs: RawObservation) => {
      observations.push(obs);
    }),
    insertObservationsBatch: vi.fn((obs: RawObservation[]) => {
      observations.push(...obs);
    }),
    getObservations: vi.fn(() => [...observations]),
    getPendingObservations: vi.fn(() => []),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(() => 0),
    searchFts: vi.fn(() => []),
    countMemories: vi.fn(() => 0),
    countObservations: vi.fn(() => observations.length),
    countPendingExtraction: vi.fn(() => 0),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(() => []),
  };
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("ObservationBuffer", () => {
  let buffer: ObservationBuffer;
  let storage: IStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new ObservationBuffer(100, 30_000);
    storage = createMockStorage();
  });

  afterEach(() => {
    buffer.detach();
    vi.useRealTimers();
  });

  // ── enqueue / size ─────────────────────────────────────────────────

  describe("enqueue", () => {
    it("deve adicionar observação ao buffer", () => {
      expect(buffer.size()).toBe(0);
      buffer.enqueue(makeObs());
      expect(buffer.size()).toBe(1);
    });

    it("deve acumular múltiplas observações", () => {
      for (let i = 0; i < 10; i++) {
        buffer.enqueue(makeObs());
      }
      expect(buffer.size()).toBe(10);
    });
  });

  describe("size", () => {
    it("deve retornar 0 para buffer vazio", () => {
      expect(buffer.size()).toBe(0);
    });

    it("deve refletir estado após flush", () => {
      buffer.attach(storage);
      buffer.enqueue(makeObs());
      expect(buffer.size()).toBe(1);
      buffer.flush();
      expect(buffer.size()).toBe(0);
    });
  });

  describe("enqueueBatch", () => {
    it("deve adicionar lote de uma vez", () => {
      buffer.enqueueBatch([makeObs(), makeObs(), makeObs()]);
      expect(buffer.size()).toBe(3);
    });
  });

  // ── flush ──────────────────────────────────────────────────────────

  describe("flush", () => {
    it("deve persistir observações via storage", () => {
      buffer.attach(storage);
      buffer.enqueue(makeObs());
      buffer.enqueue(makeObs());

      buffer.flush();

      expect(storage.insertObservationsBatch).toHaveBeenCalled();
      expect(buffer.size()).toBe(0);
    });

    it("não deve chamar storage se buffer vazio", () => {
      buffer.attach(storage);
      buffer.flush();
      expect(storage.insertObservationsBatch).not.toHaveBeenCalled();
    });

    it("não deve quebrar se storage não vinculado", () => {
      buffer.enqueue(makeObs());
      expect(() => buffer.flush()).not.toThrow();
      expect(buffer.size()).toBe(1); // não limpou
    });

    it("não deve quebrar se storage lança erro", () => {
      buffer.attach(storage);
      (storage.insertObservationsBatch as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB error");
      });

      buffer.enqueue(makeObs());
      expect(() => buffer.flush()).not.toThrow();
    });

    it("deve passar todas as observações do batch", () => {
      buffer.attach(storage);
      const obs1 = makeObs();
      const obs2 = makeObs();
      buffer.enqueue(obs1);
      buffer.enqueue(obs2);

      buffer.flush();

      const callArg = (storage.insertObservationsBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(callArg).toHaveLength(2);
      expect(callArg[0].id).toBe(obs1.id);
      expect(callArg[1].id).toBe(obs2.id);
    });
  });

  // ── auto-flush ─────────────────────────────────────────────────────

  describe("auto-flush por tamanho", () => {
    it("deve disparar flush quando buffer atinge maxSize", () => {
      const smallBuffer = new ObservationBuffer(3, 30_000);
      smallBuffer.attach(storage);

      smallBuffer.enqueue(makeObs());
      smallBuffer.enqueue(makeObs());
      smallBuffer.enqueue(makeObs()); // atinge maxSize → flush
      smallBuffer.enqueue(makeObs()); // nova obs após flush

      expect(storage.insertObservationsBatch).toHaveBeenCalledTimes(1);
      expect(smallBuffer.size()).toBe(1); // só a última

      smallBuffer.detach();
    });

    it("deve disparar flush em enqueueBatch quando atinge maxSize", () => {
      const smallBuffer = new ObservationBuffer(2, 30_000);
      smallBuffer.attach(storage);

      smallBuffer.enqueueBatch([makeObs(), makeObs(), makeObs()]);

      expect(storage.insertObservationsBatch).toHaveBeenCalledTimes(1);
      smallBuffer.detach();
    });
  });

  describe("auto-flush por intervalo", () => {
    it("deve disparar flush após flushIntervalMs", () => {
      buffer.attach(storage);
      buffer.enqueue(makeObs());
      buffer.enqueue(makeObs());

      // Avança o timer
      vi.advanceTimersByTime(30_001);

      expect(storage.insertObservationsBatch).toHaveBeenCalled();
      expect(buffer.size()).toBe(0);
    });

    it("não deve disparar flush antes do intervalo", () => {
      buffer.attach(storage);
      buffer.enqueue(makeObs());

      vi.advanceTimersByTime(15_000);

      expect(storage.insertObservationsBatch).not.toHaveBeenCalled();
      expect(buffer.size()).toBe(1);
    });

    it("deve disparar múltiplos flushes ao longo do tempo", () => {
      buffer.attach(storage);

      buffer.enqueue(makeObs());
      vi.advanceTimersByTime(30_000);
      expect(storage.insertObservationsBatch).toHaveBeenCalledTimes(1);

      buffer.enqueue(makeObs());
      vi.advanceTimersByTime(30_000);
      expect(storage.insertObservationsBatch).toHaveBeenCalledTimes(2);
    });
  });

  // ── attach / detach ────────────────────────────────────────────────

  describe("attach / detach", () => {
    it("deve parar auto-flush após detach", () => {
      buffer.attach(storage);
      buffer.enqueue(makeObs());
      buffer.detach();

      vi.advanceTimersByTime(60_000);
      // Não deve ter flushado porque detach limpa o timer
      expect(storage.insertObservationsBatch).not.toHaveBeenCalled();
      // Mas a observação continua no buffer
      expect(buffer.size()).toBe(1);
    });

    it("deve permitir re-attach com novo storage", () => {
      buffer.attach(storage);
      buffer.detach();

      const storage2 = createMockStorage();
      buffer.attach(storage2);
      buffer.enqueue(makeObs());

      vi.advanceTimersByTime(30_001);
      expect(storage2.insertObservationsBatch).toHaveBeenCalled();
    });
  });

  // ── clear ──────────────────────────────────────────────────────────

  describe("clear", () => {
    it("deve esvaziar buffer sem persistir", () => {
      buffer.attach(storage);
      buffer.enqueue(makeObs());
      buffer.enqueue(makeObs());

      buffer.clear();

      expect(buffer.size()).toBe(0);
      expect(storage.insertObservationsBatch).not.toHaveBeenCalled();
    });
  });
});
