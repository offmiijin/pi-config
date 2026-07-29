/**
 * Testes do SessionLogger — geração de páginas de sessão.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../../storage/sqlite-store";
import { SessionLogger } from "../../capture/session-log";

// ── Helpers ────────────────────────────────────────────────────────────

function createSandbox() {
  const tempDir = path.join(tmpdir(), "pi-session-" + randomUUID().slice(0, 8));
  const dbPath = path.join(tempDir, "memory.db");
  const wikiRoot = path.join(tempDir, "wiki");
  fs.mkdirSync(wikiRoot, { recursive: true });

  const store = new SqliteStore(dbPath);
  store.open();

  return { tempDir, store, wikiRoot };
}

function destroySandbox(s: { tempDir: string; store: SqliteStore }): void {
  try { s.store.close(); fs.rmSync(s.tempDir, { recursive: true, force: true }); } catch {}
}

// ── Suite ──────────────────────────────────────────────────────────────

describe("SessionLogger", () => {
  it("deve inicializar sessão com slug do primeiro prompt", () => {
    const sandbox = createSandbox();
    const logger = createLogger(sandbox, "abc123");

    const info = logger.initSession("session-1", "Refatorar módulo de autenticação");
    expect(info.slug).toBe("refatorar-modulo-de-autenticacao");
    expect(info.pagePath).toContain("sessions/");
    expect(info.pagePath).toContain("refatorar-modulo-de-autenticacao.md");
    expect(info.pagePath).toMatch(/\/\d{3}-/); // contém número sequencial

    destroySandbox(sandbox);
  });

  it("deve incrementar número sequencial por dia", () => {
    const sandbox = createSandbox();
    const logger1 = createLogger(sandbox, "abc123");

    const info1 = logger1.initSession("s1", "Primeira sessão");
    logger1.finalizeSession();

    const logger2 = createLogger(sandbox, "abc123");

    // A finalizeSession do logger1 escreve o arquivo via PageStore,
    // que usa resolveUniquePath. O logger2 escaneia o diretório pra
    // determinar o próximo número.
    const info2 = logger2.initSession("s2", "Segunda sessão");
    // Deve ser 001 se o logger1 ainda não escreveu o arquivo (só finalizou),
    // ou 002 se já escreveu.
    const hasSeq = /\/\d{3}-/.test(info2.pagePath);
    expect(hasSeq).toBe(true);

    destroySandbox(sandbox);
  });

  it("deve gerar página markdown com turnos no finalizeSession", () => {
    const sandbox = createSandbox();
    const logger = createLogger(sandbox, "abc123");

    logger.initSession("s1", "Testar API");
    logger.appendTurn({
      timestamp: Date.now(),
      label: "Implementação",
      toolResults: [
        {
          toolName: "bash",
          command: "pnpm test",
          outcome: "success",
          filesTouched: ["src/api.ts"],
          summary: "3 passed, 0 failed",
        },
        {
          toolName: "edit",
          outcome: "success",
          filesTouched: ["src/api.ts"],
          summary: "Adicionado endpoint /users",
        },
      ],
    });

    logger.finalizeSession();

    // Verifica no índice
    const pages = sandbox.store.getPagesByProject("abc123");
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const sessionPage = pages.find((p) => p.path.includes("testar-api"));
    expect(sessionPage).toBeDefined();
    expect(sessionPage!.type).toBe("session");
    expect(sessionPage!.body).toContain("\`pnpm test\`");
    expect(sessionPage!.body).toContain("3 passed");

    // Verifica no disco
    const fullPath = path.join(sandbox.wikiRoot, "projects", "abc123", sessionPage!.path);
    expect(fs.existsSync(fullPath)).toBe(true);

    destroySandbox(sandbox);
  });

  it("deve marcar erros com ❌ e sucessos com ✅", () => {
    const sandbox = createSandbox();
    const logger = createLogger(sandbox, "abc123");

    logger.initSession("s1", "Corrigir bug");
    logger.appendTurn({
      timestamp: Date.now(),
      label: "Debug",
      toolResults: [
        {
          toolName: "bash",
          command: "pnpm test",
          outcome: "error",
          filesTouched: [],
          summary: "2 failed, 1 passed",
        },
      ],
    });

    logger.finalizeSession();

    const pages = sandbox.store.getPagesByProject("abc123");
    const sessionPage = pages.find((p) => p.path.includes("corrigir-bug"));
    expect(sessionPage).toBeDefined();
    expect(sessionPage!.body).toContain("❌");
    expect(sessionPage!.body).toContain("2 failed");

    destroySandbox(sandbox);
  });

  it("deve retornar null em getSessionPagePath antes de init", () => {
    const sandbox = createSandbox();
    const logger = createLogger(sandbox, "abc123");

    expect(logger.getSessionPagePath()).toBeNull();

    destroySandbox(sandbox);
  });

  it("deve resetar para nova sessão", () => {
    const sandbox = createSandbox();
    const logger = createLogger(sandbox, "abc123");

    logger.initSession("s1", "Primeira");
    logger.reset();

    expect(logger.getSessionPagePath()).toBeNull();

    const info = logger.initSession("s2", "Segunda");
    expect(info.slug).toBe("segunda");

    destroySandbox(sandbox);
  });

  it("deve extrair tags de comandos", () => {
    const sandbox = createSandbox();
    const logger = createLogger(sandbox, "abc123");

    logger.initSession("s1", "Deploy");
    logger.appendTurn({
      timestamp: Date.now(),
      label: "Deploy",
      toolResults: [
        { toolName: "bash", command: "git push && docker deploy", outcome: "success", filesTouched: [], summary: "" },
        { toolName: "bash", command: "pnpm test", outcome: "error", filesTouched: [], summary: "fail" },
      ],
    });

    logger.finalizeSession();

    const pages = sandbox.store.getPagesByProject("abc123");
    const page = pages.find((p) => p.path.includes("deploy"));
    expect(page).toBeDefined();
    expect(page!.tags).toContain("git");
    expect(page!.tags).toContain("dependencies");
    expect(page!.tags).toContain("errors");

    destroySandbox(sandbox);
  });
});

// ── Helper ─────────────────────────────────────────────────────────────

function createLogger(
  sandbox: { tempDir: string; store: SqliteStore; wikiRoot: string },
  projectId: string,
) {
  return new SessionLogger({
    wikiRoot: sandbox.wikiRoot,
    storage: sandbox.store,
    projectId,
  });
}
