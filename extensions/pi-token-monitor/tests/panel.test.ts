import { describe, expect, it } from "vitest";
import { TokenMonitorPanel } from "../panel.ts";
import type { UsageSnapshot } from "../types.ts";

function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

function snapshot(): UsageSnapshot {
  const totals = {
    requests: 2,
    input: 100,
    output: 40,
    cacheRead: 60,
    cacheWrite: 10,
    totalTokens: 210,
    freshTokens: 150,
    cost: 3.5,
    cacheHit: 60 / 170,
  };
  return {
    generatedAt: 1000,
    from: 0,
    to: 1000,
    filter: { period: "today" },
    totals,
    records: [{
      id: "session:a",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      timestamp: 900,
      provider: "anthropic",
      model: "claude-sonnet",
      input: 100,
      output: 40,
      cacheRead: 60,
      cacheWrite: 10,
      totalTokens: 210,
      costInput: 1,
      costOutput: 2,
      costCacheRead: 0,
      costCacheWrite: 0.5,
      costTotal: 3.5,
    }],
    routers: [{ key: "anthropic", label: "anthropic", totals }],
    models: [{ key: "claude-sonnet", label: "claude-sonnet", totals }],
    availableRouters: ["anthropic", "openrouter"],
    availableModels: ["claude-sonnet"],
  };
}

function setup() {
  const calls: number[] = [];
  const queries: unknown[] = [];
  const tui = { terminal: { rows: 30 }, requestRender: () => calls.push(1) } as any;
  const panel = new TokenMonitorPanel(
    tui,
    fakeTheme(),
    snapshot(),
    (query) => queries.push(query),
    () => calls.push(2),
    () => calls.push(3),
  );
  return { panel, calls, queries };
}

describe("painel do monitor de tokens", () => {
  it("renderiza resumo com métricas e filtros", () => {
    const { panel } = setup();
    const body = panel.render(100).join("\n");
    expect(body).toContain("Monitor de Tokens");
    expect(body).toContain("TOTAL GASTO");
    expect(body).toContain("REQUISIÇÕES");
    expect(body).toContain("anthropic");
    expect(body).toContain("Modelo: Todos");
  });

  it("alinha filtros e conteúdos no mesmo recuo do título", () => {
    const { panel } = setup();
    const overview = panel.render(100).join("\n");
    expect(overview).toContain("│ Monitor de Tokens");
    expect(overview).toContain("│ Período:");
    expect(overview).toContain("│ TOTAL GASTO");

    panel.handleInput("v");
    const table = panel.render(100).join("\n");
    expect(table).toContain("│ Modelo");

    panel.handleInput("v");
    const details = panel.render(100).join("\n");
    expect(details).toContain("│ Data:");
    expect(details).toContain("│ Router:");
  });

  it("alterna entre os quatro modos", () => {
    const { panel } = setup();
    for (const title of ["Tabela", "Detalhes", "Resumo"]) {
      panel.handleInput("v");
      expect(panel.render(100).join("\n")).toContain(`· ${title}`);
    }
  });

  it("não exibe gráficos nem oferece um quarto modo", () => {
    const { panel } = setup();
    panel.handleInput("v");
    panel.handleInput("v");
    const body = panel.render(100).join("\n");
    expect(body).toContain("· Detalhes");
    expect(body).not.toContain("Gráficos");
    panel.handleInput("v");
    expect(panel.render(100).join("\n")).toContain("· Resumo");
  });

  it("abre o seletor menor ao pressionar Enter no filtro focado", async () => {
    let received: { focus: string; options: readonly unknown[] } | undefined;
    const tui = { terminal: { rows: 30 }, requestRender: () => {} } as any;
    const panel = new TokenMonitorPanel(
      tui,
      fakeTheme(),
      snapshot(),
      () => {},
      () => {},
      () => {},
      async (focus, _current, options) => {
        received = { focus, options };
        return { value: "openrouter" };
      },
    );
    panel.handleInput("\t");
    panel.handleInput("\r");
    await Promise.resolve();
    expect(received?.focus).toBe("router");
    expect(received?.options.map((option: any) => option.label)).toEqual(["Todos", "anthropic", "openrouter"]);
  });

  it("não altera filtros com as setas esquerda e direita", () => {
    const { panel, queries } = setup();
    panel.handleInput("\x1b[A");
    panel.handleInput("\x1b[B");
    panel.handleInput("\t"); // router
    panel.handleInput("\x1b[D");
    panel.handleInput("\x1b[C");
    panel.handleInput("\t"); // model
    panel.handleInput("\x1b[D");
    panel.handleInput("\x1b[C");
    expect(queries).toEqual([]);
  });

  it("fecha com Escape e atualiza com R", () => {
    const { panel, calls } = setup();
    panel.handleInput("r");
    panel.handleInput("\x1b");
    expect(calls).toEqual([2, 3]);
  });
});
