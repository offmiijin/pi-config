import { describe, expect, it } from "vitest";
import registerTokenMonitor, { requestCustomPeriod, shouldToggleTokenMonitor } from "../index.ts";

describe("extensão pi-token-monitor", () => {
  it("registra o comando /token-monitor", () => {
    const commands: Record<string, unknown> = {};
    const pi = {
      registerCommand: (name: string, definition: unknown) => { commands[name] = definition; },
      on: () => {},
    };
    registerTokenMonitor(pi as any);
    expect(commands["token-monitor"]).toBeDefined();
  });

  it("reconhece Alt+M sem repetir eventos da tecla", () => {
    expect(shouldToggleTokenMonitor("\x1bm", 1000, 0)).toBe(true);
    expect(shouldToggleTokenMonitor("\x1bm", 1100, 1000)).toBe(false);
    expect(shouldToggleTokenMonitor("\x1b[109;3:2u", 2000, 0)).toBe(false);
  });

  it("valida o período personalizado e inclui o minuto final", async () => {
    const values = ["01/01/2026 10:00", "01/01/2026 11:00"];
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        input: async () => values.shift(),
        notify: (message: string) => notifications.push(message),
      },
    } as any;
    const range = await requestCustomPeriod(ctx);
    expect(range).not.toBeNull();
    if (!range) throw new Error("período não retornado");
    expect(range.to - range.from).toBe(60 * 60_000 + 60_000);
    expect(notifications).toEqual([]);
  });
});
