/**
 * Testes da orquestração (index.ts) com fake ExtensionAPI.
 *
 * Cobre: sessão sem sandbox (--no-sandbox), nota no system prompt com dirs
 * persistentes, comando /sandbox, user_bash, session_shutdown e notificação
 * quando bwrap não está disponível.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  agentDir: "/tmp/sb-agent",
  bwrapAvailable: true,
  loadConfigCalls: [] as unknown[],
  loadConfigReturn: null as unknown,
  saveBooleanSettingCalls: [] as unknown[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => state.agentDir,
  CONFIG_DIR_NAME: ".pi",
  createReadTool: () => ({ name: "read", execute: vi.fn(async () => ({ content: [{ type: "text", text: "fallback" }] })) }),
  createWriteTool: () => ({ name: "write", execute: vi.fn() }),
  createEditTool: () => ({ name: "edit", execute: vi.fn() }),
  createBashTool: () => ({
    name: "bash",
    execute: vi.fn(async () => ({
      content: [{
        type: "text",
        text: Array.from({ length: 40 }, (_, index) => `PASS test-${index}`).join("\n"),
      }],
      details: {},
    })),
  }),
  createFindTool: () => ({ name: "find", execute: vi.fn() }),
  createLsTool: () => ({ name: "ls", execute: vi.fn() }),
  createGrepTool: () => ({ name: "grep", execute: vi.fn() }),
}));

vi.mock("../worktree", () => ({
  cleanupOrphanedWorktrees: vi.fn(),
  cleanupWorktree: vi.fn(),
  refreshWorktreeBranch: vi.fn(() => false),
  isGitRepository: vi.fn(() => true),
  createWorktree: vi.fn((originalCwd: string, worktreeRoot: string, options?: { restoreBranch?: string }) => ({
    sessionId: "test-session",
    originalCwd,
    workspaceCwd: originalCwd,
    workspaceSubdir: "",
    gitRoot: originalCwd,
    gitDir: `${originalCwd}/.git`,
    branchName: options?.restoreBranch ?? "sandbox/test-session",
    temporaryBranchName: options?.restoreBranch ? "" : "sandbox/test-session",
    originalBranchName: "main",
    baseCommit: "base-commit",
    worktreeRoot,
    worktreePath: `${worktreeRoot}/test-session`,
    startedAt: new Date().toISOString(),
  })),
  promoteWorktreePreview: vi.fn(() => []),
  restoreWorktreePreview: vi.fn(() => []),
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
    saveBooleanSetting: (...args: unknown[]) => {
      state.saveBooleanSettingCalls.push(args);
      return "/tmp/sandbox-config.json";
    },
  };
});

import extension from "../index";
import { cleanupWorktree, createWorktree, refreshWorktreeBranch } from "../worktree";
import { DEFAULT_CONFIG } from "../types";

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
  };
  sessionManager?: { getBranch: () => unknown[] };
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
  const commands = new Map<string, {
    handler: (args: string, ctx: unknown) => unknown;
    getArgumentCompletions?: (prefix: string) => unknown;
  }>();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(ev, h),
    registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => tools.push(t),
    registerCommand: (n: string, d: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(n, d),
    appendEntry: vi.fn(),
  };
  return { pi, handlers, tools, commands };
}

function fakeCtx(entries: unknown[] = []): FakeCtx {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(async () => undefined) },
    sessionManager: { getBranch: () => entries },
  };
}

beforeEach(() => {
  state.bwrapAvailable = true;
  state.loadConfigCalls = [];
  state.loadConfigReturn = null;
  state.saveBooleanSettingCalls = [];
  vi.mocked(cleanupWorktree).mockClear();
  vi.mocked(createWorktree).mockClear();
  vi.mocked(refreshWorktreeBranch).mockClear();
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

  it("restaura a branch persistida no novo worktree", async () => {
    const { pi, handlers } = fakePi();
    extension(pi as never);
    const ctx = fakeCtx([{
      type: "custom",
      customType: "dev-sandbox-state",
      data: { version: 1, branchName: "feat/new-feature" },
    }]);

    await handlers.get("session_start")!({}, ctx);

    expect(createWorktree).toHaveBeenCalledWith(
      process.cwd(),
      DEFAULT_CONFIG.worktree.root,
      { restoreBranch: "feat/new-feature" },
    );
    const prompt = handlers.get("before_agent_start")!(
      { systemPrompt: "base" },
      { cwd: process.cwd() },
    ) as { systemPrompt: string };
    expect(prompt.systemPrompt).toContain("Active Git branch: feat/new-feature");
  });

  it("persiste branch nomeada quando o worktree muda de branch", async () => {
    const { pi, handlers } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());
    vi.mocked(refreshWorktreeBranch).mockImplementationOnce((current) => {
      current.branchName = "feat/new-feature";
      return true;
    });

    handlers.get("session_shutdown")!({}, {});

    expect(pi.appendEntry).toHaveBeenCalledWith(
      "dev-sandbox-state",
      { version: 1, branchName: "feat/new-feature" },
    );
  });

  it("/sandbox abre as configurações e alterna a opção selecionada", async () => {
    const { pi, handlers, commands } = fakePi();
    extension(pi as never);
    const ctx = fakeCtx();
    ctx.hasUI = true;
    ctx.ui.select
      .mockResolvedValueOnce("Global (~/.pi/agent/extensions/pi-sandbox.json)")
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
    await handlers.get("session_start")!({}, ctx);

    await commands.get("sandbox")!.handler("", ctx);

    expect(state.saveBooleanSettingCalls).toEqual([
      [process.cwd(), "enabled", false, "global"],
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Sandbox: true → false"),
      "info",
    );
  });

  it("/sandbox info mostra informações da sessão", async () => {
    const { pi, handlers, commands } = fakePi();
    extension(pi as never);
    const ctx = fakeCtx();
    ctx.hasUI = true;
    await handlers.get("session_start")!({}, ctx);

    await commands.get("sandbox")!.handler("info", ctx);

    const calls = ctx.ui.notify.mock.calls.map((c) => c[0] as string);
    const msg = calls.find((m) => m.includes("Caches:"))!;
    expect(msg).toContain("Clones:");
    expect(msg).toContain(".sandbox-cache/clones");
  });

  it("/sandbox oferece autocomplete para info", () => {
    const { pi, commands } = fakePi();
    extension(pi as never);

    expect(commands.get("sandbox")!.getArgumentCompletions?.("in")).toEqual([
      expect.objectContaining({ value: "info" }),
    ]);
  });

  it("registra tools e comandos de preview e restore", async () => {
    const { pi, handlers, tools, commands } = fakePi();
    extension(pi as never);
    const ctx = fakeCtx();
    ctx.hasUI = true;
    await handlers.get("session_start")!({}, ctx);

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "sandbox_promote_preview",
      "sandbox_promote_restore",
    ]));
    await commands.get("promote-preview")!.handler("", ctx);
    await commands.get("promote-restore")!.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Preview promovido"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Preview restaurado"), "info");
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

  it("bash aplica compactação específica após execução sandboxed", async () => {
    const { pi, handlers, tools } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());

    const bashTool = tools.find((tool) => tool.name === "bash")!;
    const result = await bashTool.execute(
      "id",
      { command: "npm test" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain("linhas de saída omitidas");
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

  it("session_shutdown respeita cleanup never", async () => {
    state.loadConfigReturn = {
      ...structuredClone(DEFAULT_CONFIG),
      worktree: { ...structuredClone(DEFAULT_CONFIG.worktree), cleanup: "never" },
    };
    const { pi, handlers } = fakePi();
    extension(pi as never);
    await handlers.get("session_start")!({}, fakeCtx());
    handlers.get("session_shutdown")!({}, {});

    expect(cleanupWorktree).not.toHaveBeenCalled();
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
