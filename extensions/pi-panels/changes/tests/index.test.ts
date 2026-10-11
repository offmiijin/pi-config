import { describe, expect, it, vi } from "vitest";
import registerChanges, { shouldTogglePanel } from "../index.ts";
import { PANEL_SESSION_ENTRY } from "../session.ts";

describe("painel de alterações do pi-panels", () => {
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
			hasUI: true,
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
		expect(appended).toContainEqual({
			type: PANEL_SESSION_ENTRY,
			data: { version: 1, baseCommit: "base123", worktreePath: "/tmp/worktree" },
		});
	});

	it("restaura a âncora persistida após reload sem usar a âncora atual do sandbox", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		const eventHandlers: Record<string, (event: any) => unknown> = {};
		const execCalls: string[][] = [];
		let inputListener: ((data: string) => unknown) | undefined;
		let customOptions: any;
		const ctx = {
			mode: "tui",
			hasUI: true,
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
		await handlers.session_start!({ reason: "reload" }, ctx);
		eventHandlers["custom:dev-sandbox-session"]!({ worktreePath: "/tmp/worktree", baseCommit: "new-sandbox-base" });
		expect(inputListener).toBeDefined();
		inputListener!("\x1bd");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(customOptions.overlayOptions.anchor).toBe("center");
		expect(execCalls[0]).toEqual(expect.arrayContaining(["-C", "/tmp/worktree", "session-base^{commit}"]));
		expect(execCalls[0]).not.toContain("new-sandbox-base^{commit}");
	});

	it("inicia uma nova âncora em uma sessão nova", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		const eventHandlers: Record<string, (event: any) => unknown> = {};
		const execCalls: string[][] = [];
		const appended: Array<{ type: string; data: unknown }> = [];
		let inputListener: ((data: string) => unknown) | undefined;
		let customOptions: any;
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/repo",
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: "old-session-base" } }],
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
			appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		};

		registerChanges(pi as any);
		eventHandlers["custom:dev-sandbox-session"]!({ worktreePath: "/tmp/worktree", baseCommit: "new-session-base" });
		await handlers.session_start!({ reason: "new" }, ctx);
		inputListener!("\x1bd");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(customOptions.overlayOptions.anchor).toBe("center");
		expect(execCalls[0]).toEqual(expect.arrayContaining(["-C", "/tmp/worktree", "new-session-base^{commit}"]));
		expect(execCalls[0]).not.toContain("old-session-base^{commit}");
		expect(appended).toContainEqual({
			type: PANEL_SESSION_ENTRY,
			data: { version: 1, baseCommit: "new-session-base", worktreePath: "/tmp/worktree" },
		});
	});
});

describe("robustez do painel de alterações", () => {
	function setup(execImpl: (_command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> = async () => ({ stdout: "", stderr: "", code: 0 })) {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		const eventHandlers: Record<string, (event: any) => unknown> = {};
		const appended: Array<{ type: string; data: unknown }> = [];
		const notified: Array<{ message: string; level: string }> = [];
		let inputListener: ((data: string) => unknown) | undefined;
		let customOpened = false;
		let releaseCustom = () => {};
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/repo",
			sessionManager: { getBranch: () => [] },
			ui: {
				onTerminalInput: (handler: (data: string) => unknown) => {
					inputListener = handler;
					return () => { inputListener = undefined; };
				},
				notify: (message: string, level: string) => notified.push({ message, level }),
				custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) => {
					customOpened = true;
					// Executa a factory real (constrói o ChangesPanel) mas segura o overlay
					// aberto para que o refresh encontre o painel ativo.
					factory({ requestRender: () => {} }, {}, {}, () => {});
					await new Promise<void>((resolve) => { releaseCustom = resolve; });
				},
			},
		};
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers[name] = handler; },
			events: { on: (name: string, handler: (event: any) => unknown) => { eventHandlers[name] = handler; } },
			exec: execImpl,
			appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		};
		registerChanges(pi as any);
		return { handlers, eventHandlers, appended, notified, ctx, getInputListener: () => inputListener, wasCustomOpened: () => customOpened, releaseCustom: () => releaseCustom() };
	}

	it("evento do sandbox com lixo não quebra nem persiste âncora inválida", async () => {
		const { handlers, eventHandlers, appended, ctx } = setup();
		await handlers.session_start!({ reason: "new" }, ctx);
		expect(() => {
			eventHandlers["custom:dev-sandbox-session"]!(null);
			eventHandlers["custom:dev-sandbox-session"]!({ worktreePath: 123, workspaceCwd: ["x"], baseCommit: null });
			eventHandlers["custom:dev-sandbox-session"]!({ worktreePath: "  ", baseCommit: "   " });
		}).not.toThrow();
		expect(appended).toEqual([]);
	});

	it("falha do git no refresh não gera rejection (avisa e segue)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { handlers, ctx, getInputListener, releaseCustom } = setup(async () => ({ stdout: "", stderr: "", code: 0 }));
			await handlers.session_start!({ reason: "new" }, ctx);
			getInputListener()!("\x1bd");
			await new Promise((resolve) => setTimeout(resolve, 0));
			// Exec passa a lançar (sandbox fail-closed) nos refreshes seguintes.
			await handlers.tool_execution_end!({}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("atualizar o painel"), expect.anything());
			releaseCustom();
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			warn.mockRestore();
		}
	});

	it("exec lançando no refresh é contido com aviso", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			let fail = false;
			const { handlers, ctx, getInputListener, releaseCustom } = setup(async () => {
				if (fail) throw new Error("sandbox indisponível");
				return { stdout: "", stderr: "", code: 0 };
			});
			await handlers.session_start!({ reason: "new" }, ctx);
			getInputListener()!("\x1bd");
			await new Promise((resolve) => setTimeout(resolve, 0));
			fail = true;
			await handlers.tool_execution_end!({}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("[pi-panels/changes]"),
				expect.anything(),
			);
			releaseCustom();
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			warn.mockRestore();
		}
	});

	it("openPanel fora do TUI avisa em vez de abrir", async () => {
		const { handlers, ctx, getInputListener, notified, wasCustomOpened } = setup();
		await handlers.session_start!({ reason: "new" }, ctx);
		expect(getInputListener()).toBeDefined();
		// Turno seguinte fora do modo interativo: o atalho avisa e não abre o painel.
		(ctx as any).mode = "print";
		(ctx as any).hasUI = false;
		getInputListener()!("\x1bd");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(wasCustomOpened()).toBe(false);
		expect(notified).toHaveLength(1);
		expect(notified[0]!.level).toBe("error");
	});
});
