import { describe, expect, it } from "vitest";
import registerTokenMonitor, { shouldToggleTokenMonitor } from "../index.ts";

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
});
