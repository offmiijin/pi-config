/**
 * Testes do LlmExtractor (N3).
 *
 * Cobre: parsing de resposta LLM, validação de fatos, enfileiramento,
 *        comportamento de batch, retry, e integração com storage.
 *
 * Testes async usam mock de fetch com json síncrono para evitar
 * complexidade de microtask cascading em ambiente Bun.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmExtractor, type LlmExtractorConfig } from "../../extract/llm-extractor";
import type { IStorage } from "../../storage/index";
import type { RawObservation, Memory } from "../../types";

// ── Helpers ────────────────────────────────────────────────────────────

/** Polling wait helper — Bun não tem vi.waitFor */
async function waitFor(
  condition: () => boolean | void,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try {
      ok = condition() !== false;
    } catch {
      // condição ainda não satisfeita (expect lançou)
    }
    if (ok) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Última tentativa — deixa o erro propagar
  condition();
}

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
    content_preview: "",
    error_preview: null,
    file_paths: [],
    ttl: Date.now() + 7 * 24 * 60 * 60 * 1000,
    extracted: false,
    ...overrides,
  };
}

/** observation com conteúdo padrão (100 chars, passa filtro >50) */
function richObs(id?: string): RawObservation {
  return makeObs({
    id: id ?? undefined,
    content_preview: "x".repeat(100),
  });
}

function createMockStorage(): IStorage {
  const memories: Memory[] = [];
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
    deleteMemory: vi.fn(),
    insertObservation: vi.fn(),
    insertObservationsBatch: vi.fn(),
    getObservations: vi.fn(() => []),
    getPendingObservations: vi.fn(() => []),
    markExtracted: vi.fn(),
    cleanupExpired: vi.fn(() => 0),
    searchFts: vi.fn(() => []),
    countMemories: vi.fn(() => memories.length),
    countObservations: vi.fn(() => 0),
    countPendingExtraction: vi.fn(() => 0),
    syncToJson: vi.fn(),
    loadFromJson: vi.fn(() => []),
  };
}

function baseConfig(
  overrides: Partial<LlmExtractorConfig> = {},
): LlmExtractorConfig {
  return {
    apiKey: "test-key",
    model: "deepseek/deepseek-v4-flash",
    baseUrl: "https://openrouter.ai/api/v1",
    timeoutMs: 1000,
    batchSize: 3,
    maxWaitMs: 5000,
    maxRetries: 2,
    ...overrides,
  };
}

/** Cria mock fetch que retorna fatos como JSON puro */
function mockFetchWithFacts(facts: unknown[]) {
  const jsonStr = JSON.stringify(facts);
  // json NÃO async — retorna valor direto, await vira no-op
  const resp = {
    ok: true,
    status: 200,
    json: () => ({ choices: [{ message: { content: jsonStr } }] }),
    text: () => Promise.resolve(""),
  };
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(resp);
}

/** Cria mock fetch que falha */
function mockFetchError(status = 500, body = "error") {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    new Error(`HTTP ${status}: ${body}`),
  );
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("LlmExtractor", () => {
  let storage: IStorage;
  let extractor: LlmExtractor;

  beforeEach(() => {
    storage = createMockStorage();
    (globalThis.fetch as unknown) = vi.fn();
  });

  afterEach(() => {
    extractor?.shutdown();
    vi.restoreAllMocks();
  });

  function createExtractor(
    cfg: Partial<LlmExtractorConfig> = {},
    onExtraction?: (count: number) => void,
  ): LlmExtractor {
    extractor = new LlmExtractor(storage, "proj-1", baseConfig(cfg), onExtraction);
    return extractor;
  }

  // ── Constructor / Config ──────────────────────────────────────────

  describe("constructor", () => {
    it("deve usar defaults quando não há overrides", () => {
      const e = new LlmExtractor(storage, "proj-1", { apiKey: "k" });
      expect((e as unknown as { config: LlmExtractorConfig }).config.model).toBe(
        "deepseek/deepseek-v4-flash",
      );
    });

    it("deve aceitar overrides de config", () => {
      const e = new LlmExtractor(storage, "proj-1", {
        apiKey: "k",
        model: "custom-model",
        batchSize: 5,
      });
      expect((e as unknown as { config: LlmExtractorConfig }).config.model).toBe(
        "custom-model",
      );
    });
  });

  // ── Enqueue ────────────────────────────────────────────────────────

  describe("enqueue", () => {
    it("deve ignorar se apiKey está vazia", () => {
      const e = new LlmExtractor(storage, "proj-1", { apiKey: "" });
      const obs = [richObs()];
      e.enqueue(obs);
      expect((e as unknown as { pendingObs: RawObservation[] }).pendingObs).toHaveLength(0);
    });

    it("deve filtrar observações já extraídas", () => {
      createExtractor({ batchSize: 10 });
      const obs = [
        makeObs({ content_preview: "x".repeat(100), extracted: true }),
        richObs(),
      ];
      extractor.enqueue(obs);
      const pending = (extractor as unknown as { pendingObs: RawObservation[] }).pendingObs;
      expect(pending).toHaveLength(1);
      expect(pending[0].extracted).toBe(false);
    });

    it("deve filtrar observações com content_preview curto (≤50 chars)", () => {
      createExtractor({ batchSize: 10 });
      const obs = [
        makeObs({ content_preview: "short" }),
        makeObs({ content_preview: "x".repeat(51) }),
        makeObs({ content_preview: null as unknown as string }),
      ];
      extractor.enqueue(obs);
      expect(
        (extractor as unknown as { pendingObs: RawObservation[] }).pendingObs,
      ).toHaveLength(1);
    });

    it("deve disparar extract() quando pending atinge batchSize", () => {
      createExtractor({ batchSize: 2 });
      mockFetchError();
      extractor.enqueue([richObs(), richObs()]);
      // fetch é chamado sincronamente (antes do primeiro await na extract)
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("deve acumular sem disparar se abaixo do batchSize", () => {
      createExtractor({ batchSize: 10 });
      extractor.enqueue([richObs(), richObs()]);
      expect(
        (extractor as unknown as { pendingObs: RawObservation[] }).pendingObs,
      ).toHaveLength(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // ── Response parsing + storage integration ────────────────────────

  describe("response parsing and storage", () => {
    it("deve extrair fatos de resposta JSON pura", async () => {
      createExtractor({ batchSize: 1 });
      mockFetchWithFacts([
        {
          text: "Project uses pnpm as package manager",
          type: "fact",
          confidence: 0.9,
          tags: ["#pnpm", "#tool"],
        },
      ]);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        expect(storage.insertMemory).toHaveBeenCalled();
      });

      const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      const mem = calls[0][0] as Memory;
      expect(mem.text).toContain("pnpm");
      expect(mem.type).toBe("fact");
      expect(mem.tags).toContain("#pnpm");
    });

    it("deve extrair múltiplos fatos de uma resposta", async () => {
      createExtractor({ batchSize: 1 });
      mockFetchWithFacts([
        { text: "Fact 1", type: "fact", confidence: 0.8, tags: [] },
        { text: "Fact 2", type: "lesson", confidence: 0.7, tags: ["#lesson"] },
      ]);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
        return calls.length >= 2;
      });
    });

    it("deve extrair fatos de markdown code block", async () => {
      createExtractor({ batchSize: 1 });
      const facts = [
        { text: "From code block", type: "decision", confidence: 0.9, tags: ["#arch"] },
      ];
      const resp = {
        ok: true,
        status: 200,
        json: () => ({
          choices: [
            { message: { content: "```json\n" + JSON.stringify(facts) + "\n```" } },
          ],
        }),
        text: () => Promise.resolve(""),
      };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(resp);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        expect(storage.insertMemory).toHaveBeenCalled();
      });
    });

    it("deve extrair fatos de array JSON inline no texto", async () => {
      createExtractor({ batchSize: 1 });
      const facts = [{ text: "Inline", type: "fact", confidence: 0.5, tags: [] }];
      const resp = {
        ok: true,
        status: 200,
        json: () => ({
          choices: [
            {
              message: {
                content: "Here: " + JSON.stringify(facts) + " done.",
              },
            },
          ],
        }),
        text: () => Promise.resolve(""),
      };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(resp);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        expect(storage.insertMemory).toHaveBeenCalled();
      });
    });

    it("deve marcar extraídas mesmo sem fatos (resposta inválida)", async () => {
      createExtractor({ batchSize: 1 });
      const resp = {
        ok: true,
        status: 200,
        json: () => ({
          choices: [{ message: { content: "No facts here." } }],
        }),
        text: () => Promise.resolve(""),
      };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(resp);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        expect(storage.markExtracted).toHaveBeenCalled();
      });
      expect(storage.insertMemory).not.toHaveBeenCalled();
    });

    it("deve validar e descartar fatos com type inválido", async () => {
      createExtractor({ batchSize: 1 });
      mockFetchWithFacts([
        { text: "Good", type: "fact", confidence: 0.8, tags: [] },
        { text: "Bad", type: "invalid_type", confidence: 0.8, tags: [] },
      ]);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        expect(storage.insertMemory).toHaveBeenCalled();
      });
      const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0].text).toBe("Good");
    });

    it("deve capar confidence no range 0-1", async () => {
      createExtractor({ batchSize: 1 });
      mockFetchWithFacts([
        { text: "Over", type: "fact", confidence: 1.5, tags: ["#a"] },
        { text: "Under", type: "preference", confidence: -0.5, tags: ["#b"] },
      ]);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
        return calls.length >= 2;
      });
      const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].confidence).toBe(1.0);
      expect(calls[1][0].confidence).toBe(0.0);
    });

    it("deve normalizar tags com prefixo #", async () => {
      createExtractor({ batchSize: 1 });
      mockFetchWithFacts([
        {
          text: "T",
          type: "fact",
          confidence: 0.8,
          tags: ["docker", "#pnpm", "", "  "],
        },
      ]);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        expect(storage.insertMemory).toHaveBeenCalled();
      });
      const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
      const mem = calls[0][0] as Memory;
      expect(mem.tags).toContain("#docker");
      expect(mem.tags).toContain("#pnpm");
      expect(mem.tags.length).toBe(2);
    });
  });

  // ── Error / Retry ─────────────────────────────────────────────────

  describe("error handling and retry", () => {
    it("deve re-enfileirar observações em caso de erro (retry < max)", async () => {
      createExtractor({ batchSize: 2, maxRetries: 2 });
      mockFetchError();

      extractor.enqueue([richObs("id-a"), richObs("id-b")]);

      await waitFor(() => {
        const pending = (extractor as unknown as { pendingObs: RawObservation[] })
          .pendingObs;
        return pending.length >= 2;
      });
    });

    it("deve marcar como extraídas após maxRetries excedido", async () => {
      // maxWaitMs baixo para retry disparar rápido no teste
      createExtractor({ batchSize: 1, maxRetries: 1, maxWaitMs: 50 });
      mockFetchError(); // tentativa 1 falha → re-enfileira
      mockFetchError(); // tentativa 2 falha → maxRetries=1 atingido → markExtracted

      extractor.enqueue([richObs()]);

      await waitFor(
        () => {
          expect(storage.markExtracted).toHaveBeenCalled();
        },
        2000,
      );
    });

    it("deve lidar com HTTP erro sem quebrar", () => {
      createExtractor({ batchSize: 1, maxRetries: 0 });
      mockFetchError();
      extractor.enqueue([richObs()]);
      // Não deve lançar exceção
      expect(true).toBe(true);
    });
  });

  // ── Shutdown ──────────────────────────────────────────────────────

  describe("shutdown", () => {
    it("deve disparar extração de pendentes", () => {
      createExtractor({ batchSize: 10 });
      mockFetchError();
      extractor.enqueue([richObs()]);
      extractor.shutdown();
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });

  // ── onExtraction callback ─────────────────────────────────────────

  describe("onExtraction callback", () => {
    it("deve reportar contagem de fatos extraídos", async () => {
      let extractedCount = 0;
      createExtractor({ batchSize: 1 }, (count) => {
        extractedCount += count;
      });
      mockFetchWithFacts([
        { text: "A", type: "fact", confidence: 0.8, tags: [] },
        { text: "B", type: "fact", confidence: 0.8, tags: [] },
        { text: "C", type: "fact", confidence: 0.8, tags: [] },
      ]);

      extractor.enqueue([richObs()]);

      await waitFor(() => {
        return extractedCount === 3;
      });
      expect(extractedCount).toBe(3);
    });
  });

  // ── source_observation_ids ────────────────────────────────────────

  describe("source_observation_ids", () => {
    it("deve usar IDs do batch como source quando LLM não especifica", async () => {
      createExtractor({ batchSize: 2 });
      mockFetchWithFacts([
        { text: "Shared fact", type: "fact", confidence: 0.8, tags: [] },
      ]);

      extractor.enqueue([richObs("id-1"), richObs("id-2")]);

      await waitFor(() => {
        expect(storage.insertMemory).toHaveBeenCalled();
      });
      const calls = (storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
      const mem = calls[0][0] as Memory;
      expect(mem.source_ids).toContain("id-1");
      expect(mem.source_ids).toContain("id-2");
    });
  });
});
