import { describe, expect, it } from "vitest";
import { reconstructPanelSession } from "../changes/session.ts";
import { getPeriodBounds, parseSessionText } from "../token-monitor/data.ts";

describe("estado dos painéis", () => {
  it("recupera a última âncora Git válida e ignora entradas inválidas", () => {
    expect(reconstructPanelSession([
      { type: "custom", customType: "pi-panel-session", data: { version: 1, baseCommit: " abc " } },
      { type: "custom", customType: "pi-panel-session", data: { version: 2, baseCommit: "old" } },
      { type: "custom", customType: "pi-panel-session", data: { version: 1, baseCommit: "def", workspaceCwd: " /tmp/work " } },
    ])).toEqual({ version: 1, baseCommit: "def", workspaceCwd: "/tmp/work" });
  });

  it("extrai apenas mensagens de uso do modelo", () => {
    const records = parseSessionText([
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "oi" } }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", provider: "openai", model: "gpt", usage: { input: 10, output: 4, totalTokens: 14, cost: { total: 0.01 } } } }),
      "linha incompleta",
    ].join("\n"), "session.jsonl");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "s1:m1", provider: "openai", totalTokens: 14, costTotal: 0.01 });
  });

  it("inverte limites customizados quando necessário", () => {
    expect(getPeriodBounds("custom", 100, { from: 90, to: 10 })).toEqual({ from: 10, to: 90 });
  });
});
