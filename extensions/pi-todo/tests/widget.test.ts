import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { addTodos, createTodoState, updateTodo } from "../state.ts";
import { MAX_WIDGET_ITEMS, renderWidgetLines, updateTodoWidget, WIDGET_ID } from "../widget.ts";

function fakeTheme() {
	return { fg: (c: string, t: string) => `${c}:${t}` } as any;
}

describe("widget — renderWidgetLines", () => {
	it("zero tarefas → sem linhas", () => {
		expect(renderWidgetLines(createTodoState(), fakeTheme(), 80)).toEqual([]);
	});

	it("uma tarefa → uma linha com bolinha", () => {
		const s = addTodos(createTodoState(), ["a"]).state;
		const lines = renderWidgetLines(s, fakeTheme(), 80);
		expect(lines).toHaveLength(1);
		expect(lines[0]!).toContain("●");
	});

	it("cinco tarefas → cinco linhas, sem indicador", () => {
		const s = addTodos(createTodoState(), ["1", "2", "3", "4", "5"]).state;
		const lines = renderWidgetLines(s, fakeTheme(), 80);
		expect(lines).toHaveLength(MAX_WIDGET_ITEMS);
		expect(lines.some((l) => l.includes("mais"))).toBe(false);
	});

	it("seis tarefas → cinco linhas + indicador de 1 restante", () => {
		const s = addTodos(createTodoState(), ["1", "2", "3", "4", "5", "6"]).state;
		const lines = renderWidgetLines(s, fakeTheme(), 80);
		expect(lines).toHaveLength(MAX_WIDGET_ITEMS + 1);
		expect(lines[5]).toContain("+ 1 mais");
	});

	it("cores por status: muted/warning/success/error", () => {
		let s = addTodos(createTodoState(), ["a"]).state;
		const dotColor = () => renderWidgetLines(s, fakeTheme(), 80)[0]!.split(":")[0];
		expect(dotColor()).toBe("muted");
		s = updateTodo(s, 1, "in-progress").state;
		expect(dotColor()).toBe("warning");
		s = updateTodo(s, 1, "done").state;
		expect(dotColor()).toBe("success");
		s = updateTodo(s, 1, "error", "falhou").state;
		expect(dotColor()).toBe("error");
	});

	it("respeita a largura do terminal (largura visível)", () => {
		const s = addTodos(createTodoState(), ["x".repeat(300)]).state;
		for (const line of renderWidgetLines(s, fakeTheme(), 40)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});

describe("widget — updateTodoWidget (atualização central)", () => {
	function fakeCtx() {
		const calls: { id: string; content: unknown }[] = [];
		return {
			calls,
			ctx: {
				hasUI: true,
				ui: { setWidget: (id: string, content: unknown) => calls.push({ id, content }) },
			} as any,
		};
	}

	it("lista vazia → remove o widget (content undefined)", () => {
		const { calls, ctx } = fakeCtx();
		updateTodoWidget(ctx, { value: createTodoState() });
		expect(calls.at(-1)).toEqual({ id: WIDGET_ID, content: undefined });
	});

	it("com tarefas → re-registra projeção viva", () => {
		const { calls, ctx } = fakeCtx();
		const holder = { value: addTodos(createTodoState(), ["a", "b"]).state };
		updateTodoWidget(ctx, holder);
		expect(calls.at(-1)!.id).toBe(WIDGET_ID);
		expect(calls.at(-1)!.content).not.toBeUndefined();
		const factory = calls.at(-1)!.content as (t: unknown, theme: any) => { render: (w: number) => string[] };
		expect(factory(null, fakeTheme()).render(80)).toHaveLength(2);
	});

	it("sem UI → nenhuma chamada", () => {
		const { calls } = fakeCtx();
		updateTodoWidget({ hasUI: false, ui: { setWidget: () => calls.push({ id: "", content: undefined }) } } as any, {
			value: addTodos(createTodoState(), ["a"]).state,
		});
		expect(calls).toHaveLength(0);
	});
});
