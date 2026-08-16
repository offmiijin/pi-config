import { describe, expect, it } from "vitest";
import {
	addTodos,
	clearTodos,
	createTodoState,
	isTodoStatus,
	snapshot,
	updateTodo,
} from "../state.ts";

describe("estado — add", () => {
	it("adiciona tarefa única em pending", () => {
		const r = addTodos(createTodoState(), ["tarefa"]);
		expect(r.ok).toBe(true);
		expect(r.state.items).toEqual([{ id: 1, text: "tarefa", status: "pending" }]);
		expect(r.state.nextId).toBe(2);
	});

	it("adiciona múltiplas tarefas com ids incrementais e trimmagem", () => {
		const r = addTodos(createTodoState(), ["  a  ", "b", "  c"]);
		expect(r.ok).toBe(true);
		expect(r.state.items.map((t) => t.id)).toEqual([1, 2, 3]);
		expect(r.state.items[0]!.text).toBe("a");
		expect(r.state.nextId).toBe(4);
	});

	it("rejeita lista vazia e texto vazio (all-or-nothing)", () => {
		const s = createTodoState();
		expect(addTodos(s, []).ok).toBe(false);
		const r = addTodos(s, ["a", "   "]);
		expect(r.ok).toBe(false);
		expect(r.state).toBe(s); // sem mutação
		expect(r.state.items).toHaveLength(0);
	});
});

describe("estado — update", () => {
	it("atualiza para cada status válido", () => {
		let s = addTodos(createTodoState(), ["a"]).state;
		s = updateTodo(s, 1, "in-progress").state;
		expect(s.items[0]!.status).toBe("in-progress");
		s = updateTodo(s, 1, "done").state;
		expect(s.items[0]!.status).toBe("done");
		s = updateTodo(s, 1, "pending").state; // retrabalho
		expect(s.items[0]!.status).toBe("pending");
	});

	it("registra erro com motivo e limpa o motivo ao sair de error", () => {
		let s = addTodos(createTodoState(), ["a"]).state;
		s = updateTodo(s, 1, "error", "  motivo  ").state;
		expect(s.items[0]).toEqual({ id: 1, text: "a", status: "error", error: "motivo" });
		s = updateTodo(s, 1, "pending").state;
		expect(s.items[0]).toEqual({ id: 1, text: "a", status: "pending" });
		expect("error" in s.items[0]!).toBe(false);
	});

	it("rejeita id inexistente (não cria item)", () => {
		const s = addTodos(createTodoState(), ["a"]).state;
		const r = updateTodo(s, 99, "done");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("não encontrada");
		expect(r.state.items).toHaveLength(1);
	});

	it("impede estados inválidos: status desconhecido e error sem motivo", () => {
		const s = addTodos(createTodoState(), ["a"]).state;
		expect(updateTodo(s, 1, "banana" as never).ok).toBe(false);
		expect(updateTodo(s, 1, "error").ok).toBe(false);
		expect(updateTodo(s, 1, "error", "  ").ok).toBe(false);
	});

	it("permite no máximo um in-progress (novo reverte anterior)", () => {
		let s = addTodos(createTodoState(), ["a", "b", "c"]).state;
		s = updateTodo(s, 1, "in-progress").state;
		s = updateTodo(s, 2, "in-progress").state;
		const byId = Object.fromEntries(s.items.map((t) => [t.id, t.status]));
		expect(byId[1]).toBe("pending");
		expect(byId[2]).toBe("in-progress");
	});
});

describe("estado — invariantes", () => {
	it("preserva ordem de criação", () => {
		let s = addTodos(createTodoState(), ["a", "b", "c"]).state;
		s = updateTodo(s, 2, "done").state;
		s = updateTodo(s, 1, "in-progress").state;
		expect(s.items.map((t) => t.text)).toEqual(["a", "b", "c"]);
	});

	it("mutações são imutáveis (estado original intacto)", () => {
		const s = addTodos(createTodoState(), ["a"]).state;
		updateTodo(s, 1, "done");
		expect(s.items[0]!.status).toBe("pending");
	});

	it("snapshot é cópia profunda (mutação externa não vaza)", () => {
		const s = addTodos(createTodoState(), ["a"]).state;
		const snap = snapshot(s);
		(snap.items[0] as { text: string }).text = "alterado";
		expect(s.items[0]!.text).toBe("a");
		expect(snap.items[0]!.text).toBe("alterado");
	});

	it("clear zera lista e reinicia nextId", () => {
		const s = addTodos(createTodoState(), ["a", "b"]).state;
		const c = clearTodos();
		expect(c).toEqual({ items: [], nextId: 1 });
		expect(s.items).toHaveLength(2); // clear não muta o estado anterior
	});

	it("isTodoStatus aceita apenas valores válidos", () => {
		expect(isTodoStatus("pending")).toBe(true);
		expect(isTodoStatus("in-progress")).toBe(true);
		expect(isTodoStatus("done")).toBe(true);
		expect(isTodoStatus("error")).toBe(true);
		expect(isTodoStatus("banana")).toBe(false);
		expect(isTodoStatus(undefined)).toBe(false);
		expect(isTodoStatus(42)).toBe(false);
	});
});
