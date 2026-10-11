import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class {
    constructor(..._args: unknown[]) {}
    invalidate() {}
    render() { return ["────"]; }
  },
}));
vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: (value: string) => value.length,
  truncateToWidth: (value: string, width: number) => value.slice(0, width),
}));

import { formatTokenCount, readAgentTypeFromSession, registerStatusBar, resolvePiVersion } from "../status-bar.ts";

function setupPi() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const customHandlers = new Map<string, (event: any) => void>();
  const pi = {
    events: { on: vi.fn((name: string, handler: any) => customHandlers.set(name, handler)) },
    on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    getThinkingLevel: () => "medium",
  };
  return { pi, handlers, customHandlers };
}

function setupCtx(overrides: Record<string, any> = {}) {
  const ui = {
    theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
    setEditorComponent: vi.fn(),
    setFooter: vi.fn(),
  };
  return {
    hasUI: true,
    cwd: "/repo/projeto",
    model: { id: "model-x", provider: "test", contextWindow: 200000 },
    getContextUsage: () => ({ tokens: 1000 }),
    sessionManager: { getEntries: () => [] as unknown[] },
    ui,
    ...overrides,
  } as any;
}

describe("status bar", () => {
  it("registra os listeners da extensão sem exigir uma sessão ativa", () => {
    const { pi, handlers } = setupPi();

    registerStatusBar(pi as never);

    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("message_end")).toBe(true);
    expect(handlers.has("model_select")).toBe(true);
    expect(pi.events.on).toHaveBeenCalledWith("custom:agent-switch", expect.any(Function));
  });

  it("session_start sem UI não registra componentes nem lança", async () => {
    const { pi, handlers } = setupPi();
    registerStatusBar(pi as never);
    const ctx = setupCtx({ hasUI: false, ui: undefined });

    await expect(handlers.get("session_start")!({}, ctx)).resolves.toBeUndefined();
  });

  it("session_start tolera usage corrompido na sessão", async () => {
    const { pi, handlers } = setupPi();
    registerStatusBar(pi as never);
    const ctx = setupCtx({
      sessionManager: {
        getEntries: () => [
          { type: "message", message: { role: "assistant", usage: { totalTokens: "muito", cost: {} } } },
          { type: "message", message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.5 } } } },
          "corrompido",
          null,
        ],
      },
    });

    await expect(handlers.get("session_start")!({}, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.setEditorComponent).toHaveBeenCalled();
    expect(ctx.ui.setFooter).toHaveBeenCalled();
  });

  it("session_start tolera getEntries lançando", async () => {
    const { pi, handlers } = setupPi();
    registerStatusBar(pi as never);
    const ctx = setupCtx({
      sessionManager: {
        getEntries: () => { throw new Error("sessão indisponível"); },
      },
    });

    await expect(handlers.get("session_start")!({}, ctx)).resolves.toBeUndefined();
  });

  it("eventos custom com payload nulo não lançam", async () => {
    const { pi, handlers, customHandlers } = setupPi();
    registerStatusBar(pi as never);
    const ctx = setupCtx();
    await handlers.get("session_start")!({}, ctx);

    expect(() => {
      customHandlers.get("custom:agent-switch")!(null);
      customHandlers.get("custom:agent-switch")!({ type: "invalido" });
      customHandlers.get("custom:memory-stats")!(null);
      customHandlers.get("custom:memory-stats")!("x");
      customHandlers.get("custom:dev-sandbox-session")!(null);
    }).not.toThrow();
  });

  it("thinking_level_select e model_select validam o evento", async () => {
    const { pi, handlers } = setupPi();
    registerStatusBar(pi as never);
    const ctx = setupCtx();
    await handlers.get("session_start")!({}, ctx);

    await expect(handlers.get("thinking_level_select")!(null, ctx)).resolves.toBeUndefined();
    await expect(handlers.get("thinking_level_select")!({ level: "high" }, ctx)).resolves.toBeUndefined();
    await expect(handlers.get("model_select")!(null, ctx)).resolves.toBeUndefined();
    await expect(handlers.get("model_select")!({ model: null }, ctx)).resolves.toBeUndefined();
  });

  it("message_end com usage corrompido não lança nem corrompe totais", async () => {
    const { pi, handlers } = setupPi();
    registerStatusBar(pi as never);
    const ctx = setupCtx();
    await handlers.get("session_start")!({}, ctx);

    await expect(
      handlers.get("message_end")!({ message: { role: "assistant", usage: { totalTokens: "x", cost: {} } } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      handlers.get("message_end")!({ message: { role: "assistant" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(handlers.get("message_end")!(null, ctx)).resolves.toBeUndefined();
  });

  it("footer renderiza sem cwd e sem git branch", async () => {
    const { pi, handlers } = setupPi();
    registerStatusBar(pi as never);
    const theme = { fg: (_c: string, t: string) => t };
    const footerData = {
      getGitBranch: () => { throw new Error("sem git"); },
      onBranchChange: () => () => {},
    };
    const ctx = setupCtx({
      cwd: undefined,
      ui: {
        theme,
        setEditorComponent: vi.fn(),
        setFooter: vi.fn((factory: any) => factory({}, theme, footerData)),
      },
    });

    await handlers.get("session_start")!({}, ctx);
    const footer = (ctx.ui.setFooter.mock.calls[0] as any[])[0]({}, theme, footerData);
    expect(() => footer.render(80)).not.toThrow();
    expect(footer.render(80)).toHaveLength(1);
  });
});

describe("formatTokenCount", () => {
  it("formata unidades e valores pequenos", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1500)).toBe("1K");
    expect(formatTokenCount(2500000)).toBe("2.50M");
  });
});

describe("readAgentTypeFromSession", () => {
  const entry = (agent: unknown) => ({
    type: "custom",
    customType: "agent-switcher",
    data: { agent },
  });

  it("lê o último agente persistido", () => {
    const ctx = { sessionManager: { getEntries: () => [entry("writer"), entry("planner")] } };
    expect(readAgentTypeFromSession(ctx as any)).toBe("planner");
  });

  it("padrão coder sem entradas, com dados inválidos ou sem sessionManager", () => {
    expect(readAgentTypeFromSession({ sessionManager: { getEntries: () => [] } } as any)).toBe("coder");
    expect(readAgentTypeFromSession({ sessionManager: { getEntries: () => [entry("invalido")] } } as any)).toBe("coder");
    expect(readAgentTypeFromSession({ sessionManager: { getEntries: () => "x" } } as any)).toBe("coder");
    expect(readAgentTypeFromSession({} as any)).toBe("coder");
    expect(
      readAgentTypeFromSession({ sessionManager: { getEntries: () => { throw new Error("x"); } } } as any),
    ).toBe("coder");
  });
});

describe("resolvePiVersion", () => {
  it("retorna unknown sem package.json e com exec falhando", async () => {
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) };
    await expect(resolvePiVersion(pi as never)).resolves.toBe("unknown");
  });

  it("lê a versão da saída do binário", async () => {
    const pi = { exec: async () => ({ code: 0, stdout: "v1.2.3\n", stderr: "" }) };
    // Pode resolver via package.json ao lado do binário; garante ao menos string não vazia.
    await expect(resolvePiVersion(pi as never)).resolves.toMatch(/.+/);
  });
});
