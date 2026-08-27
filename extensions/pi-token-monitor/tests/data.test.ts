import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPeriodBounds, parseSessionText, UsageStore } from "../data.ts";

const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function line(entry: object): string {
  return JSON.stringify(entry);
}

describe("monitor de tokens — leitura de sessões", () => {
  it("extrai somente mensagens assistant com usage e ignora linha incompleta", () => {
    const records = parseSessionText([
      line({ type: "session", id: "session-1" }),
      line({ type: "message", id: "user-1", message: { role: "user", content: "oi" } }),
      line({
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          provider: "openrouter",
          model: "openai/gpt-5",
          responseModel: "openai/gpt-5.4",
          timestamp: 1_000,
          usage: {
            input: 100,
            output: 25,
            cacheRead: 75,
            cacheWrite: 5,
            totalTokens: 205,
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
          },
        },
      }),
      "{incompleto",
    ].join("\n"), "/tmp/session.jsonl");

    expect(records).toEqual([expect.objectContaining({
      id: "session-1:assistant-1",
      sessionId: "session-1",
      provider: "openrouter",
      model: "openai/gpt-5",
      responseModel: "openai/gpt-5.4",
      input: 100,
      output: 25,
      cacheRead: 75,
      cacheWrite: 5,
      costTotal: 3.3,
    })]);
  });

  it("agrega sessões, aplica período/modelo/router e mantém cache por arquivo", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-token-monitor-"));
    files.push(root);
    const session = join(root, "session.jsonl");
    await writeFile(session, [
      line({ type: "session", id: "session-1" }),
      line({
        type: "message", id: "a", message: {
          role: "assistant", provider: "anthropic", model: "claude-sonnet",
          timestamp: 95_000, usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 10, totalTokens: 210, cost: { total: 2 } },
        },
      }),
      line({
        type: "message", id: "b", message: {
          role: "assistant", provider: "openai", model: "gpt-5",
          timestamp: 50_000, usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 1 } },
        },
      }),
    ].join("\n"));

    const store = new UsageStore(root);
    const snapshot = await store.snapshot({ period: "last15m", now: 100_000, router: "anthropic" });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.totals.requests).toBe(1);
    expect(snapshot.totals.freshTokens).toBe(130);
    expect(snapshot.totals.cacheHit).toBeCloseTo(80 / 190);
    expect(snapshot.routers[0]?.label).toBe("anthropic");
    expect(snapshot.models[0]?.label).toBe("claude-sonnet");

    const second = await store.snapshot({ period: "last15m", now: 100_000 });
    expect(second.records).toHaveLength(2);
    expect(second.totals.cost).toBe(3);
  });
});

describe("monitor de tokens — períodos", () => {
  it("calcula janelas corridas", () => {
    expect(getPeriodBounds("last15m", 1_000_000)).toEqual({ from: 100_000, to: 1_000_000 });
    expect(getPeriodBounds("last48h", 1_000_000)).toEqual({
      from: 1_000_000 - 48 * 60 * 60_000,
      to: 1_000_000,
    });
  });
});
