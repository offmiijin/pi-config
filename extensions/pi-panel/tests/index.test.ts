import { describe, expect, it } from "vitest";
import registerChanges, { shouldTogglePanel } from "../index.ts";
import { PANEL_SESSION_ENTRY } from "../session.ts";

describe("extensão pi-panel", () => {
	it("ignora repetições do Alt+D enquanto a tecla permanece pressionada", () => {
		expect(shouldTogglePanel("\x1bd", 1000, 0)).toBe(true);
		expect(shouldTogglePanel("\x1bd", 1100, 1000)).toBe(false);
		// Kitty: D + Alt, evento de repetição (:2u).
		expect(shouldTogglePanel("\x1b[100;3:2u", 2000, 0)).toBe(false);
	});

	it("intercepta Alt+D e usa o worktree/base emitidos pelo sandbox", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		const eventHandlers: Record<string, (event: any) => unknown> = {};
		const execCalls: string[][] = [];
		const appended: Array<{ type: string; data: unknown }> = [];
		let inputListener: ((data: string) => unknown) | undefined;
		let customOptions: any;
		let shortcutRegistered = false;
		const ctx = {
			mode: "tui",
			cwd: "/repo",
			sessionManager: { getBranch: () => [] },
			ui: {
				onTerminalInput: (handler: (data: string) => unknown) => {
					inputListener = handler;
					return () => { inputListener = undefined; };
				},
				notify: () => {},
				custom: async (_factory: unknown, options: unknown) => { customOptions = options; },
			},
		};
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers[name] = handler; },
			events: {
				on: (name: string, handler: (event: any) => unknown) => { eventHandlers[name] = handler; },
			},
			registerShortcut: () => { shortcutRegistered = true; },
			exec: async (_command: string, args: string[]) => {
				execCalls.push(args);
				return { stdout: "", stderr: "", code: 0 };
			},
			appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		};

		registerChanges(pi as any);
		eventHandlers["custom:dev-sandbox-session"]!({
			worktreePath: "/tmp/worktree",
			baseCommit: "base123",
		});
		await handlers.session_start!({}, ctx);

		expect(shortcutRegistered).toBe(false);
		expect(inputListener).toBeDefined();
		expect(inputListener!("\x1bd")).toEqual({ consume: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(customOptions.overlayOptions.anchor).toBe("center");
		expect(execCalls[0]).toEqual(expect.arrayContaining(["-C", "/tmp/worktree", "base123^{commit}"]));
		expect(appended).toContainEqual({ type: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: "base123" } });
	});

	it("restaura a âncora persistida após reload sem usar a âncora atual do sandbox", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		const eventHandlers: Record<string, (event: any) => unknown> = {};
		const execCalls: string[][] = [];
		let inputListener: ((data: string) => unknown) | undefined;
		let customOptions: any;
		const ctx = {
			mode: "tui",
			cwd: "/repo",
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: "session-base" } }],
			},
			ui: {
				onTerminalInput: (handler: (data: string) => unknown) => {
					inputListener = handler;
					return () => { inputListener = undefined; };
				},
				notify: () => {},
				custom: async (_factory: unknown, options: unknown) => { customOptions = options; },
			},
		};
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers[name] = handler; },
			events: { on: (name: string, handler: (event: any) => unknown) => { eventHandlers[name] = handler; } },
			exec: async (_command: string, args: string[]) => {
				execCalls.push(args);
				return { stdout: "", stderr: "", code: 0 };
			},
			appendEntry: () => {},
		};

		registerChanges(pi as any);
		eventHandlers["custom:dev-sandbox-session"]!({ worktreePath: "/tmp/worktree", baseCommit: "new-sandbox-base" });
		await handlers.session_start!({ reason: "reload" }, ctx);
		expect(inputListener).toBeDefined();
		inputListener!("\x1bd");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(customOptions.overlayOptions.anchor).toBe("center");
		expect(execCalls[0]).toEqual(expect.arrayContaining(["-C", "/tmp/worktree", "session-base^{commit}"]));
		expect(execCalls[0]).not.toContain("new-sandbox-base^{commit}");
	});
});
