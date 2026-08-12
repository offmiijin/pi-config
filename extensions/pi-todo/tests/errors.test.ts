import { describe, expect, it } from "vitest";
import { registerAutoError } from "../errors.ts";
import { TODO_STATE_ENTRY } from "../reconstruct.ts";
import { addTodos, createTodoState, updateTodo } from "../state.ts";
import type { TodoToolState } from "../tools.ts";
import { WIDGET_ID } from "../widget.ts";

function setup() {
	const holder: TodoToolState = { value: createTodoState() };
	const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
	const appended: { type: string; data: unknown }[] = [];
	const widgetCalls: { id: string; content: unknown }[] = [];
	const fakePi = {
		on: (name: string, handler: (event: any, ctx: any) => Promise<void>) => {
			handlers[name] = handler;
		},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	const ctx = {
		hasUI: true,
		ui: { setWidget: (id: string, content: unknown) => widgetCalls.push({ id, content }) },
	};
	registerAutoError(fakePi as any, holder);
	return {
		holder,
		appended,
		widgetCalls,
		fire: (event: any) => handlers["tool_execution_end"]!(event, ctx as any),
	};
}

describe("erro automático", () => {
	it("erro de ferramenta marca a tarefa ativa como error", async () => {
		const { holder, appended, widgetCalls, fire } = setup();
		holder.value = updateTodo(addTodos(createTodoState(), ["a", "b"]).state, 1, "in-progress").state;

		await fire({ isError: true, toolName: "bash", result: { content: [{ type: "text", text: "EACCES" }] } });

		expect(holder.value.items[0]!.status).toBe("error");
		expect(holder.value.items[0]!.error).toBe("falha em bash: EACCES");
		expect(appended).toHaveLength(1);
		expect(appended[0]!.type).toBe(TODO_STATE_ENTRY);
		expect((appended[0]!.data as any).items[0].status).toBe("error");
		expect(widgetCalls.at(-1)!.id).toBe(WIDGET_ID);
	});

	it("motivo extraído do 1º bloco de texto e truncado a 200 chars", async () => {
		const { holder, fire } = setup();
		holder.value = updateTodo(addTodos(createTodoState(), ["a"]).state, 1, "in-progress").state;
		const texto = "x".repeat(500);
		await fire({ isError: true, toolName: "edit", result: { content: [{ type: "text", text: texto }] } });
		expect(holder.value.items[0]!.error!.length).toBeLessThanOrEqual("falha em edit: ".length + 200);
	});

	it("erro não altera tarefa done", async () => {
		const { holder, fire } = setup();
		holder.value = updateTodo(addTodos(createTodoState(), ["a"]).state, 1, "done").state;
		await fire({ isError: true, toolName: "bash", result: {} });
		expect(holder.value.items[0]!.status).toBe("done");
	});

	it("sem tarefa ativa não cria nem marca nada", async () => {
		const { holder, appended, fire } = setup();
		holder.value = addTodos(createTodoState(), ["a"]).state; // pending
		await fire({ isError: true, toolName: "bash", result: {} });
		expect(holder.value.items).toHaveLength(1);
		expect(holder.value.items[0]!.status).toBe("pending");
		expect(appended).toHaveLength(0);
	});

	it("erro da própria tool todo não dispara recursão", async () => {
		const { holder, appended, fire } = setup();
		holder.value = updateTodo(addTodos(createTodoState(), ["a"]).state, 1, "in-progress").state;
		await fire({ isError: true, toolName: "todo", result: {} });
		expect(holder.value.items[0]!.status).toBe("in-progress");
		expect(appended).toHaveLength(0);
	});

	it("múltiplos erros paralelos → só o primeiro marca (estado consistente)", async () => {
		const { holder, fire } = setup();
		holder.value = updateTodo(addTodos(createTodoState(), ["a"]).state, 1, "in-progress").state;
		await fire({ isError: true, toolName: "bash", result: {} });
		await fire({ isError: true, toolName: "edit", result: { content: [{ type: "text", text: "x" }] } });
		expect(holder.value.items[0]!.status).toBe("error");
		expect(holder.value.items[0]!.error).toBe("falha em bash");
	});

	it("isError false não dispara nada", async () => {
		const { holder, appended, fire } = setup();
		holder.value = updateTodo(addTodos(createTodoState(), ["a"]).state, 1, "in-progress").state;
		await fire({ isError: false, toolName: "bash", result: {} });
		expect(holder.value.items[0]!.status).toBe("in-progress");
		expect(appended).toHaveLength(0);
	});
});
