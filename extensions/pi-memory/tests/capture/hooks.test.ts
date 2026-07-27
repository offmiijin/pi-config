/**
 * Testes dos hooks de captura.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createCaptureHooks, type CaptureHooks, type CaptureHooksOptions } from "../../capture/hooks";
import { ObservationBuffer } from "../../capture/buffer";
import { RegexExtractor } from "../../extract/regex-extractor";
import type { IStorage } from "../../storage/index";
import type { RawObservation } from "../../types";
import { randomUUID } from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────

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

function createMockCtx(): Parameters<CaptureHooks["onToolResult"]>[1] {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/fake/project",
  } as unknown as Parameters<CaptureHooks["onToolResult"]>[1];
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("CaptureHooks", () => {
  let hooks: CaptureHooks;
  let buffer: ObservationBuffer;
  let storage: IStorage;
  const sessionId = randomUUID();
  const projectId = "test-project";

  beforeEach(() => {
    storage = createMockStorage();
    buffer = new ObservationBuffer(100, 0); // sem auto-flush para testes
    buffer.attach(storage);
    hooks = createCaptureHooks({ buffer, projectId, sessionId });
  });

  afterEach(() => {
    buffer.detach();
  });

  function getFlushedObservations(): RawObservation[] {
    buffer.flush();
    // Pega as chamadas de insertObservationsBatch
    const calls = (storage.insertObservationsBatch as ReturnType<typeof vi.fn>).mock.calls;
    const allObs: RawObservation[] = [];
    for (const call of calls) {
      allObs.push(...(call[0] as RawObservation[]));
    }
    return allObs;
  }

  // ── onToolResult ─────────────────────────────────────────────────

  describe("onToolResult", () => {
    it("deve criar observação do tipo tool_result", () => {
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "pnpm install" },
          content: "Packages installed",
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs).toHaveLength(1);
      expect(obs[0].type).toBe("tool_result");
      expect(obs[0].tool_name).toBe("bash");
      expect(obs[0].outcome).toBe("success");
      expect(obs[0].session_id).toBe(sessionId);
      expect(obs[0].project_id).toBe(projectId);
    });

    it("deve registrar outcome=error quando isError=true", () => {
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-2",
          input: { command: "invalid-cmd" },
          content: "command not found",
          isError: true,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].outcome).toBe("error");
      expect(obs[0].error_preview).not.toBeNull();
    });

    it("deve extrair error_preview dos details (stderr)", () => {
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-3",
          input: { command: "bad" },
          content: "",
          isError: true,
          details: { stderr: "Permission denied", exitCode: 1 },
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].error_preview).toBe("Permission denied");
    });

    it("deve extrair error_preview dos details (error)", () => {
      hooks.onToolResult(
        {
          toolName: "read",
          toolCallId: "call-4",
          input: { path: "/nonexistent" },
          content: "",
          isError: true,
          details: { error: "ENOENT: no such file" },
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].error_preview).toBe("ENOENT: no such file");
    });

    it("deve truncar content_preview a 2KB", () => {
      const longContent = "x".repeat(3000);
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-5",
          input: { command: "cat bigfile" },
          content: longContent,
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].content_preview.length).toBeLessThanOrEqual(2048);
    });

    it("deve extrair content_preview de array de content blocks", () => {
      hooks.onToolResult(
        {
          toolName: "read",
          toolCallId: "call-6",
          input: { path: "/file" },
          content: [
            { type: "text", text: "Hello" },
            { type: "error", text: "Warning" },
          ],
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].content_preview).toContain("Hello");
      expect(obs[0].content_preview).toContain("Warning");
    });

    it("deve extrair file_paths do input", () => {
      hooks.onToolResult(
        {
          toolName: "read",
          toolCallId: "call-7",
          input: { path: "/src/auth.ts" },
          content: "content...",
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].file_paths).toEqual(["/src/auth.ts"]);
    });

    it("deve extrair file_paths de edits", () => {
      hooks.onToolResult(
        {
          toolName: "edit",
          toolCallId: "call-8",
          input: {
            edits: [{ oldText: "a", newText: "b", path: "/src/a.ts" }],
          },
          content: "ok",
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].file_paths).toContain("/src/a.ts");
    });

    it("deve extrair file_paths de comandos bash", () => {
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-9",
          input: { command: "cat /etc/hosts /tmp/log" },
          content: "...",
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].file_paths).toContain("/etc/hosts");
      expect(obs[0].file_paths).toContain("/tmp/log");
    });

    it("deve extrair file_paths dos details", () => {
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-10",
          input: { command: "git status" },
          content: "M file1.ts",
          isError: false,
          details: { files: ["file1.ts", "file2.ts"] },
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].file_paths).toContain("file1.ts");
      expect(obs[0].file_paths).toContain("file2.ts");
    });

    it("deve sanear input (truncar strings longas)", () => {
      hooks.onToolResult(
        {
          toolName: "bash",
          toolCallId: "call-11",
          input: { command: "x".repeat(5000) },
          content: "ok",
          isError: false,
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      const parsedInput = JSON.parse(obs[0].input_json!);
      expect((parsedInput.command as string).length).toBeLessThanOrEqual(4096 + 1); // +1 for "…"
    });

    it("deve gerar IDs únicos por observação", () => {
      hooks.onToolResult(
        { toolName: "bash", toolCallId: "c1", input: {}, content: "a", isError: false },
        createMockCtx()
      );
      hooks.onToolResult(
        { toolName: "bash", toolCallId: "c2", input: {}, content: "b", isError: false },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs).toHaveLength(2);
      expect(obs[0].id).not.toBe(obs[1].id);
    });

    it("deve marcar extracted=false por padrão", () => {
      hooks.onToolResult(
        { toolName: "bash", toolCallId: "c", input: {}, content: "", isError: false },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].extracted).toBe(false);
    });

    it("deve definir TTL de 7 dias (em ms)", () => {
      const before = Date.now();
      hooks.onToolResult(
        { toolName: "bash", toolCallId: "c", input: {}, content: "", isError: false },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      const expectedTtl = before + 7 * 24 * 60 * 60 * 1000;
      expect(obs[0].ttl).toBeGreaterThanOrEqual(expectedTtl);
      expect(obs[0].ttl).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
    });
  });

  // ── onBeforeAgentStart ────────────────────────────────────────────

  describe("onBeforeAgentStart", () => {
    it("deve criar observação do tipo user_prompt", () => {
      hooks.onBeforeAgentStart(
        {
          prompt: "Como fazer deploy do payment-api?",
          systemPrompt: "...",
          systemPromptOptions: {},
        },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs).toHaveLength(1);
      expect(obs[0].type).toBe("user_prompt");
      expect(obs[0].tool_name).toBeNull();
      expect(obs[0].outcome).toBe("success");
      expect(obs[0].error_preview).toBeNull();
      expect(obs[0].file_paths).toEqual([]);
    });

    it("deve armazenar prompt no content_preview", () => {
      const prompt = "Explique hexagonal architecture";
      hooks.onBeforeAgentStart(
        { prompt, systemPrompt: "...", systemPromptOptions: {} },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].content_preview).toBe(prompt);
    });

    it("deve armazenar prompt no input_json", () => {
      const prompt = "Refatore o módulo de auth";
      hooks.onBeforeAgentStart(
        { prompt, systemPrompt: "...", systemPromptOptions: {} },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      const parsedInput = JSON.parse(obs[0].input_json!);
      expect(parsedInput.prompt).toBe(prompt);
    });

    it("deve truncar prompt longo no content_preview", () => {
      const longPrompt = "x".repeat(3000);
      hooks.onBeforeAgentStart(
        { prompt: longPrompt, systemPrompt: "...", systemPromptOptions: {} },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs[0].content_preview.length).toBeLessThanOrEqual(2048);
    });
  });

  // ── onTurnEnd ─────────────────────────────────────────────────────

  describe("onTurnEnd", () => {
    it("não deve quebrar (placeholder)", () => {
      expect(() =>
        hooks.onTurnEnd({ turnIndex: 0, message: {} }, createMockCtx())
      ).not.toThrow();
    });
  });

  // ── onSessionShutdown ─────────────────────────────────────────────

  describe("onSessionShutdown", () => {
    it("deve disparar flush do buffer", () => {
      hooks.onToolResult(
        { toolName: "bash", toolCallId: "c", input: {}, content: "x", isError: false },
        createMockCtx()
      );

      // Ainda não flusou
      expect(buffer.size()).toBe(1);

      hooks.onSessionShutdown({ reason: "quit" }, createMockCtx());

      // Deve ter flushado
      expect(buffer.size()).toBe(0);
      expect(storage.insertObservationsBatch).toHaveBeenCalled();
    });

    it("não deve quebrar com buffer vazio", () => {
      expect(() =>
        hooks.onSessionShutdown({ reason: "quit" }, createMockCtx())
      ).not.toThrow();
    });
  });

  // ── IDs únicos entre hooks ────────────────────────────────────────

  // ── N2 Regex Extraction ──────────────────────────────────────────

  describe("N2 regex extraction (via regexExtractor + storage)", () => {
    let hooksWithN2: CaptureHooks;
    let n2Storage: IStorage;
    let n2Buffer: ObservationBuffer;
    let extractor: RegexExtractor;
    let n2CallCount: number;

    beforeEach(() => {
      n2Storage = createMockStorage();
      n2Buffer = new ObservationBuffer(100, 0);
      n2Buffer.attach(n2Storage);
      extractor = new RegexExtractor();
      n2CallCount = 0;

      hooksWithN2 = createCaptureHooks({
        buffer: n2Buffer,
        projectId,
        sessionId,
        regexExtractor: extractor,
        storage: n2Storage,
        onN2Extraction: (count) => {
          n2CallCount += count;
        },
      });
    });

    afterEach(() => {
      n2Buffer.detach();
    });

    function flushN2Obs(): RawObservation[] {
      n2Buffer.flush();
      const calls = (n2Storage.insertObservationsBatch as ReturnType<typeof vi.fn>).mock.calls;
      const allObs: RawObservation[] = [];
      for (const call of calls) {
        allObs.push(...(call[0] as RawObservation[]));
      }
      return allObs;
    }

    it("deve extrair fatos de conteúdo que contém padrão de erro (test failure)", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-1",
          input: { command: "pnpm test" },
          content: "Tests: 3 failed, 10 passed, 13 total\nsrc/auth.spec.ts",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(true);
      expect(n2CallCount).toBeGreaterThan(0);
      expect(n2Storage.insertMemory).toHaveBeenCalled();
    });

    it("deve extrair fatos de stack trace", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-2",
          input: { command: "node server.js" },
          content: "",
          isError: true,
          details: {
            stderr: "TypeError: Cannot read properties of undefined (reading 'map')\n    at processUsers (src/auth.ts:42:15)",
            exitCode: 1,
          },
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(true);
      expect(n2CallCount).toBeGreaterThan(0);
    });

    it("deve extrair fatos de git commit", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-3",
          input: { command: "git commit -m 'fix'" },
          content: "[main a1b2c3d] fix: auth bug in login flow",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(true);
      expect(n2CallCount).toBeGreaterThan(0);
    });

    it("deve extrair fatos de dependência adicionada", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-4",
          input: { command: "pnpm add zod" },
          content: "added 1 package: zod@3.23.8",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(true);
      expect(n2CallCount).toBeGreaterThan(0);
    });

    it("deve extrair fatos de declaração de preferência", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-5",
          input: { command: "echo pref" },
          content: "Sempre use pnpm em todos os projetos.",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(true);
    });

    it("NÃO deve extrair de conteúdo trivial (sem padrão)", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "ls",
          toolCallId: "n2-6",
          input: { path: "/src" },
          content: "file1.ts\nfile2.ts\nfile3.ts",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(false);
      // onN2Extraction não deve ser chamado
      expect(n2CallCount).toBe(0);
    });

    it("NÃO deve quebrar se regexExtractor lança erro", () => {
      const brokenExtractor = {
        extract: () => {
          throw new Error("boom");
        },
      } as unknown as RegexExtractor;

      const brokenHooks = createCaptureHooks({
        buffer: n2Buffer,
        projectId,
        sessionId,
        regexExtractor: brokenExtractor,
        storage: n2Storage,
      });

      expect(() =>
        brokenHooks.onToolResult(
          {
            toolName: "bash",
            toolCallId: "n2-7",
            input: {},
            content: "some content",
            isError: false,
          },
          createMockCtx()
        )
      ).not.toThrow();
    });

    it("deve passar conteúdo vazio sem quebrar", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-8",
          input: {},
          content: "",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(false);
    });

    it("deve funcionar sem regexExtractor (N2 desabilitado)", () => {
      const hooksNoN2 = createCaptureHooks({
        buffer: n2Buffer,
        projectId,
        sessionId,
        // sem regexExtractor e storage
      });

      hooksNoN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-9",
          input: { command: "pnpm test" },
          content: "Tests: 5 failed, 0 passed",
          isError: false,
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(false);
      // insertMemory NÃO deve ser chamado (sem storage)
      expect(n2Storage.insertMemory).not.toHaveBeenCalled();
    });

    it("deve reportar contagem correta via onN2Extraction com múltiplos fatos", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-10",
          input: { command: "pnpm test" },
          content: "Tests: 2 failed, 8 passed. Sempre use vitest para testes.",
          isError: false,
          details: { files: ["src/auth.spec.ts"] },
        },
        createMockCtx()
      );

      const obs = flushN2Obs();
      expect(obs[0].extracted).toBe(true);
      // Deve ter extraído pelo menos 2 fatos (test failure + preference/rule)
      expect(n2CallCount).toBeGreaterThanOrEqual(2);
    });

    it("deve criar memórias com os metadados corretos (project_id, source_ids)", () => {
      hooksWithN2.onToolResult(
        {
          toolName: "bash",
          toolCallId: "n2-11",
          input: { command: "pnpm add zod" },
          content: "added 1 package: zod@3.23.8",
          isError: false,
        },
        createMockCtx()
      );

      flushN2Obs();

      const insertCalls = (n2Storage.insertMemory as ReturnType<typeof vi.fn>).mock.calls;
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);

      const insertedMemory = insertCalls[0][0];
      expect(insertedMemory.project_id).toBe(projectId);
      expect(insertedMemory.content_hash).toBeTruthy();
      expect(insertedMemory.type).toBe("fact");
      expect(insertedMemory.scope).toBe("project");
      expect(insertedMemory.tags).toContain("#dependencies");
    });
  });

  // ── IDs únicos entre hooks ────────────────────────────────────────

  describe("integração entre hooks", () => {
    it("deve gerar observações com IDs distintos entre diferentes tipos", () => {
      hooks.onBeforeAgentStart(
        { prompt: "hello", systemPrompt: "...", systemPromptOptions: {} },
        createMockCtx()
      );
      hooks.onToolResult(
        { toolName: "bash", toolCallId: "c1", input: {}, content: "a", isError: false },
        createMockCtx()
      );
      hooks.onToolResult(
        { toolName: "read", toolCallId: "c2", input: {}, content: "b", isError: false },
        createMockCtx()
      );

      const obs = getFlushedObservations();
      expect(obs).toHaveLength(3);
      const ids = obs.map((o) => o.id);
      expect(new Set(ids).size).toBe(3);
    });
  });
});
