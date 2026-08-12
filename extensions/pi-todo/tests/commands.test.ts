import { describe, expect, it } from "vitest";
import { registerTodosCommand } from "../commands.ts";
import { addTodos, createTodoState } from "../state.ts";
import type { TodoToolState } from "../tools.ts";

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
	registerTodosCommand(
		{ registerCommand: (_name: string, d: any) => (handler = d.handler) } as any,
		holder,
	);
	const ctx = {
		mode,
		ui: {
			notify: (m: string) => notified.push(m),
			custom: async (f: any) => {
				customCalled++;
				factory = f;
			},
		},
	};
	return {
		holder,
		notified,
		run: () => handler("", ctx as any),
		customCalled: () => customCalled,
		factory: () => factory,
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

	it("Esc fecha o componente", async () => {
		const s = setup("tui");
		await s.run();
		let closed = false;
		const comp = s.factory()!(null, fakeTheme(), null, () => (closed = true));
		comp.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
