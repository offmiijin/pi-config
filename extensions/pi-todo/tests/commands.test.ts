import { describe, expect, it } from "vitest";
import { registerTodosCommand, shouldToggleTodos } from "../commands.ts";
import { addTodos, createTodoState } from "../state.ts";
import type { TodoToolState } from "../state.ts";

function fakeTheme() {
	return {
		fg: (c: string, t: string) => `${c}:${t}`,
		bold: (t: string) => `**${t}**`,
	} as any;
}

function setup(mode: string) {
	const holder: TodoToolState = { value: createTodoState() };
	let handler: (args: string, ctx: any) => Promise<void> = async () => {};
	const notified: string[] = [];
	let customCalled = 0;
	let factory: ((tui: any, theme: any, kb: any, done: () => void) => any) | null = null;
	let terminalHandler: ((data: string) => unknown) | undefined;
	let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
	registerTodosCommand(
		{
			registerCommand: (_name: string, d: any) => (handler = d.handler),
			on: (event: string, handler: (event: unknown, ctx: any) => void) => {
				if (event === "session_start") sessionStart = handler;
			},
		} as any,
		holder,
	);
	const ctx = {
		mode,
		ui: {
			notify: (m: string) => notified.push(m),
			onTerminalInput: (f: (data: string) => unknown) => {
				terminalHandler = f;
				return () => { terminalHandler = undefined; };
			},
			custom: async (f: any) => {
				customCalled++;
				factory = f;
				f(null, fakeTheme(), null, () => {});
			},
		},
	};
	return {
		holder,
		notified,
		run: () => handler("", ctx as any),
		start: () => sessionStart?.({}, ctx as any),
		customCalled: () => customCalled,
		factory: () => factory,
		fireTerminalInput: (data: string) => terminalHandler?.(data),
	};
}

const lines = (comp: any) => comp.render(100);

describe("comando /todos", () => {
	it("modo não-TUI → notify de erro, sem abrir custom", async () => {
		const s = setup("print");
		await s.run();
		expect(s.notified[0]).toContain("requer modo interativo");
		expect(s.customCalled()).toBe(0);
	});

	it("TUI → mostra TODAS as tarefas (6, além das 5 do widget)", async () => {
		const s = setup("tui");
		s.holder.value = addTodos(createTodoState(), ["1", "2", "3", "4", "5", "6"]).state;
		await s.run();
		expect(s.customCalled()).toBe(1);
		const comp = s.factory()!(null, fakeTheme(), null, () => {});
		const rendered = lines(comp);
		expect(rendered.filter((l: string) => l.includes("●")).length).toBe(6);
		expect(rendered.some((l: string) => l.includes("6"))).toBe(true);
	});

	it("lista vazia → mensagem de estado vazio", async () => {
		const s = setup("tui");
		await s.run();
		const comp = s.factory()!(null, fakeTheme(), null, () => {});
		expect(lines(comp).some((l: string) => l.includes("Lista vazia"))).toBe(true);
	});

	it("mostra resumo de concluídas", async () => {
		const s = setup("tui");
		s.holder.value = addTodos(createTodoState(), ["a", "b"]).state;
		await s.run();
		const comp = s.factory()!(null, fakeTheme(), null, () => {});
		expect(lines(comp).some((l: string) => l.includes("0/2 concluídas"))).toBe(true);
	});

	it("Alt+T abre e fecha a lista completa", async () => {
		const s = setup("tui");
		s.holder.value = addTodos(createTodoState(), ["1", "2", "3", "4", "5", "6"]).state;
		await s.start();
		s.fireTerminalInput("\x1b\x74");
		await Promise.resolve();
		expect(s.customCalled()).toBe(1);
		s.fireTerminalInput("\x1b\x74");
		await Promise.resolve();
		expect(s.customCalled()).toBe(1);
	});

	it("ignora repetição e respeita debounce do Alt+T", () => {
		expect(shouldToggleTodos("\x1b\x74", 1000, 0)).toBe(true);
		expect(shouldToggleTodos("\x1b\x74", 1100, 1000)).toBe(false);
	});

	it("Esc fecha o componente", async () => {
		const s = setup("tui");
		await s.run();
		let closed = false;
		const comp = s.factory()!(null, fakeTheme(), null, () => (closed = true));
		comp.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
