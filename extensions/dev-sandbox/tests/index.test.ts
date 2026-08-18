/**
 * Testes da orquestração (index.ts) com fake ExtensionAPI.
 *
 * Cobre: sessão sem sandbox (--no-sandbox), nota no system prompt com dirs
 * persistentes, comando /sandbox, user_bash, session_shutdown e notificação
 * quando bwrap não está disponível.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ agentDir: "/tmp/sb-agent", bwrapAvailable: true, loadConfigCalls: [] as unknown[], loadConfigReturn: null as unknown }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => state.agentDir,
  CONFIG_DIR_NAME: ".pi",
  createReadTool: () => ({ name: "read", execute: vi.fn(async () => ({ content: [{ type: "text", text: "fallback" }] })) }),
  createWriteTool: () => ({ name: "write", execute: vi.fn() }),
  createEditTool: () => ({ name: "edit", execute: vi.fn() }),
  createBashTool: () => ({ name: "bash", execute: vi.fn() }),
  createFindTool: () => ({ name: "find", execute: vi.fn() }),
  createLsTool: () => ({ name: "ls", execute: vi.fn() }),
  createGrepTool: () => ({ name: "grep", execute: vi.fn() }),
}));

vi.mock("../worktree", () => ({
  cleanupOrphanedWorktrees: vi.fn(),
  cleanupWorktree: vi.fn(),
  createWorktree: vi.fn((originalCwd: string, worktreeRoot: string) => ({
    sessionId: "test-session",
    originalCwd,
    workspaceCwd: originalCwd,
    workspaceSubdir: "",
    gitRoot: originalCwd,
    gitDir: `${originalCwd}/.git`,
    branchName: "sandbox/test-session",
    originalBranchName: "main",
    baseCommit: "base-commit",
    worktreeRoot,
    worktreePath: `${worktreeRoot}/test-session`,
    startedAt: new Date().toISOString(),
  })),
  promoteWorktreeChanges: vi.fn(() => []),
}));

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    isBwrapAvailable: () => state.bwrapAvailable,
    isRgAvailable: () => true,
    getBwrapInstallGuide: () => "guia-teste",
    loadConfig: (...args: unknown[]) => {
      state.loadConfigCalls.push(args);
      if (state.loadConfigReturn !== null) return state.loadConfigReturn;
      return structuredClone(DEFAULT_CONFIG);
    },
  };
});

import extension from "../index";
import { DEFAULT_CONFIG } from "../types";

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(ev, h),
    registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => tools.push(t),
    registerCommand: (n: string, d: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(n, d),
  };
  return { pi, handlers, tools, commands };
}

function fakeCtx(): FakeCtx {
  return { cwd: process.cwd(), hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn() } };
}

beforeEach(() => {
  state.bwrapAvailable = true;
  state.loadConfigCalls = [];
  state.loadConfigReturn = null;
});

describe("index — orquestração", () => {
  it("before_agent_start injeta nota com dirs persistentes e aviso de /tmp", async () => {
    const { pi, handlers } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());

    const res = handlers.get("before_agent_start")!(
      { systemPrompt: "base" },
      { cwd: process.cwd() },
    ) as { systemPrompt: string };

    expect(res.systemPrompt).toContain("base");
    expect(res.systemPrompt).toContain("sandboxed");
    expect(res.systemPrompt).toContain(".sandbox-cache/clones");
    expect(res.systemPrompt).toContain("/tmp is ephemeral");
  });

  it("comando /sandbox mostra caches e clone dir", async () => {
    const { pi, handlers, commands } = fakePi();
    extension(pi as never);
    const ctx = fakeCtx();
    ctx.hasUI = true;
    await handlers.get("session_start")!({}, ctx);

    commands.get("sandbox")!.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalled();
    // 1ª chamada é o notify de inicialização; a do /sandbox contém Caches:/Clones:
    const calls = ctx.ui.notify.mock.calls.map((c) => c[0] as string);
    const msg = calls.find((m) => m.includes("Caches:"))!;
    expect(msg).toContain("Clones:");
    expect(msg).toContain(".sandbox-cache/clones");
  });

  it("--no-sandbox: tools usam fallback original", async () => {
    const { pi, handlers, tools } = fakePi();
    pi.getFlag = vi.fn(() => true);
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());

    const readTool = tools.find((t) => t.name === "read")!;
    const res = await readTool.execute("id", { path: "/x" }, undefined, undefined, { cwd: process.cwd() }) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0].text).toBe("fallback");
  });

  it("--no-sandbox: notifica usuário", async () => {
    const { pi, handlers } = fakePi();
    pi.getFlag = vi.fn(() => true);
    extension(pi as never);
    const ctx = fakeCtx();
    ctx.hasUI = true;
    await handlers.get("session_start")!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("--no-sandbox"),
      "warning",
    );
  });

  it("user_bash: devolve operations quando habilitado", async () => {
    const { pi, handlers } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());

    const res = handlers.get("user_bash")!({}, { cwd: process.cwd() }) as { operations: { exec: unknown } };
    expect(res.operations).toBeDefined();
    expect(typeof res.operations.exec).toBe("function");
  });

  it("session_shutdown desativa e before_agent_start para de injetar", async () => {
    const { pi, handlers } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());
    handlers.get("session_shutdown")!({}, {});

    const res = handlers.get("before_agent_start")!({ systemPrompt: "base" }, { cwd: process.cwd() });
    expect(res).toBeUndefined();
  });

  it("sem bwrap: sandbox desabilitado com notify de erro", async () => {
    state.bwrapAvailable = false;
    const { pi, handlers } = fakePi();
    extension(pi as never);
    const ctx = fakeCtx();
    ctx.hasUI = true;
    await handlers.get("session_start")!({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("bubblewrap não encontrado"),
      "error",
    );
    // Desabilitado → before_agent_start não injeta
    const res = handlers.get("before_agent_start")!({ systemPrompt: "base" }, { cwd: process.cwd() });
    expect(res).toBeUndefined();
  });

  it("bwrap ausente → tools bloqueadas (fail-closed)", async () => {
    state.bwrapAvailable = false;
    const { pi, handlers, tools } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());

    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("id", { path: "/x" }, undefined, undefined, { cwd: process.cwd() }),
    ).rejects.toThrow(/bloqueada/);
  });

  it("consulta ctx.isProjectTrusted ao carregar config", async () => {
    const { pi, handlers } = fakePi();
    extension(pi as never);
    const ctx = { ...fakeCtx(), isProjectTrusted: () => false };
    await handlers.get("session_start")!({}, ctx);
    expect(state.loadConfigCalls[0]).toEqual([process.cwd(), { projectTrusted: false }]);
  });

  it("config enabled:false → opt-out explícito → fallback para tools do host", async () => {
    state.loadConfigReturn = { ...structuredClone(DEFAULT_CONFIG), enabled: false };
    const { pi, handlers, tools } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());

    const readTool = tools.find((t) => t.name === "read")!;
    const res = await readTool.execute("id", { path: "/x" }, undefined, undefined, { cwd: process.cwd() }) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0].text).toBe("fallback");
  });
});
