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

import { registerStatusBar } from "../status-bar.ts";

describe("status bar", () => {
  it("registra os listeners da extensão sem exigir uma sessão ativa", () => {
    const handlers = new Map<string, unknown>();
    const pi = {
      events: { on: vi.fn() },
      on: vi.fn((event: string, handler: unknown) => handlers.set(event, handler)),
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    };

    registerStatusBar(pi as never);

    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("message_end")).toBe(true);
    expect(handlers.has("model_select")).toBe(true);
    expect(pi.events.on).toHaveBeenCalledWith("custom:agent-switch", expect.any(Function));
  });
});
