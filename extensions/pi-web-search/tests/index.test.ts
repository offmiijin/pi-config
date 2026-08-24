import { describe, expect, it, vi } from "vitest";

const fetchPages = vi.hoisted(() => vi.fn());
const installRenderer = vi.hoisted(() => vi.fn());
const validateRendererInstallation = vi.hoisted(() => vi.fn());

vi.mock("../fetch", () => ({ fetchPages }));
vi.mock("../renderer-install", () => ({ installRenderer, validateRendererInstallation }));
vi.mock("../agent", () => ({ registerWebAgent: vi.fn() }));
vi.mock("../search", () => ({
  search: vi.fn(),
  isSearxngReachable: vi.fn(),
  validateProvider: vi.fn(),
}));

describe("web_fetch — workspace efetivo", () => {
  it("grava no worktree informado pelo pi-sandbox", async () => {
    fetchPages.mockResolvedValueOnce({
      total: 1,
      succeeded: 1,
      failed: 0,
      outputDir: "/tmp/worktree/.sandbox-cache/fetch/page_session",
      binaryDir: "/tmp/worktree/.sandbox-cache/fetch/page_session",
      results: [{ url: "https://example.com", file: "example.md", size: 10, status: 200 }],
    });

    const listeners = new Map<string, (event: unknown) => void>();
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const pi = {
      events: {
        on: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
      },
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.push(tool),
    };

    const { default: extension } = await import("../index");
    extension(pi as never);
    listeners.get("custom:dev-sandbox-session")?.({ workspaceCwd: "/tmp/worktree" });

    const tool = tools.find((entry) => entry.name === "web_fetch");
    await tool?.execute(
      "id",
      { urls: ["https://example.com"] },
      undefined,
      undefined,
      { cwd: "/home/project", sessionManager: { getSessionId: () => "session" } },
    );

    expect(fetchPages).toHaveBeenCalledWith(
      ["https://example.com"],
      "/tmp/worktree",
      undefined,
      undefined,
      "session",
    );
  });

  it("instala o renderer via comando de configuração", async () => {
    validateRendererInstallation.mockResolvedValueOnce({ ok: true });
    installRenderer.mockResolvedValueOnce({
      ok: true,
      command: "/tmp/pi-web-renderer",
      output: "instalado",
    });

    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      events: { on: vi.fn() },
      on: vi.fn(),
      registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        commands.set(name, command);
      },
      registerTool: vi.fn(),
    };
    const notify = vi.fn();
    const setStatus = vi.fn();

    const { default: extension } = await import("../index");
    extension(pi as never);
    await commands.get("web_search")?.handler("config renderer install", {
      hasUI: false,
      ui: { notify, setStatus },
    });

    expect(installRenderer).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Renderer instalado"),
      "info",
    );
  });
});
