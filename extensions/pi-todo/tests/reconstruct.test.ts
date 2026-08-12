import { describe, expect, it } from "vitest";
import {
	normalizeTodoItem,
	normalizeTodoState,
	reconstructState,
	TODO_STATE_ENTRY,
} from "../reconstruct.ts";

describe("reconstrução — normalizeTodoItem", () => {
	it("aceita item válido", () => {
		expect(normalizeTodoItem({ id: 1, text: "a", status: "pending" })).toEqual({
			id: 1,
			text: "a",
			status: "pending",
		});
	});

	it("rejeita id inválido (não-inteiro, zero, string)", () => {
		expect(normalizeTodoItem({ id: 0, text: "a", status: "pending" })).toBeNull();
		expect(normalizeTodoItem({ id: 1.5, text: "a", status: "pending" })).toBeNull();
		expect(normalizeTodoItem({ id: "1", text: "a", status: "pending" })).toBeNull();
		expect(normalizeTodoItem(null)).toBeNull();
		expect(normalizeTodoItem("x")).toBeNull();
	});

	it("rejeita texto vazio e status desconhecido", () => {
		expect(normalizeTodoItem({ id: 1, text: "  ", status: "pending" })).toBeNull();
		expect(normalizeTodoItem({ id: 1, text: "a", status: "banana" })).toBeNull();
	});

	it("error exige mensagem; fora de error remove o campo", () => {
		expect(normalizeTodoItem({ id: 1, text: "a", status: "error" })).toBeNull();
		expect(normalizeTodoItem({ id: 1, text: "a", status: "error", error: "  x  " })).toEqual({
			id: 1,
			text: "a",
			status: "error",
			error: "x",
		});
		expect(normalizeTodoItem({ id: 1, text: "a", status: "done", error: "residual" })).toEqual({
			id: 1,
			text: "a",
			status: "done",
		});
	});
});

describe("reconstrução — normalizeTodoState", () => {
	it("aceita snapshot válido e ignora campos extras (action/error da tool)", () => {
		const s = normalizeTodoState({
			action: "update",
			items: [{ id: 1, text: "a", status: "in-progress" }],
			nextId: 2,
			error: undefined,
		});
		expect(s).toEqual({ items: [{ id: 1, text: "a", status: "in-progress" }], nextId: 2 });
	});

	it("rejeita nextId inválido ou <= maior id", () => {
		expect(normalizeTodoState({ items: [{ id: 1, text: "a", status: "pending" }], nextId: 1 })).toBeNull();
		expect(normalizeTodoState({ items: [], nextId: 0 })).toBeNull();
		expect(normalizeTodoState({ items: [], nextId: 1.5 })).toBeNull();
	});

	it("rejeita ids duplicados", () => {
		expect(
			normalizeTodoState({
				items: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 1, text: "b", status: "pending" },
				],
				nextId: 3,
			}),
		).toBeNull();
	});

	it("rejeita mais de um in-progress", () => {
		expect(
			normalizeTodoState({
				items: [
					{ id: 1, text: "a", status: "in-progress" },
					{ id: 2, text: "b", status: "in-progress" },
				],
				nextId: 3,
			}),
		).toBeNull();
	});
});

describe("reconstrução — reconstructState a partir do branch", () => {
	const toolEntry = (details: unknown) => ({
		type: "message",
		message: { role: "toolResult", toolName: "todo", details },
	});
	const customEntry = (data: unknown) => ({ type: "custom", customType: TODO_STATE_ENTRY, data });

	it("branch vazio → estado vazio", () => {
		expect(reconstructState([])).toEqual({ items: [], nextId: 1 });
	});

	it("entradas não relacionadas são ignoradas", () => {
		const entries = [
			{ type: "custom", customType: "outra-ext", data: {} },
			{ type: "message", message: { role: "user", content: "oi" } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
		];
		expect(reconstructState(entries)).toEqual({ items: [], nextId: 1 });
	});

	it("último snapshot válido da tool vence", () => {
		const entries = [
			toolEntry({ action: "add", items: [{ id: 1, text: "a", status: "pending" }], nextId: 2 }),
			toolEntry({ action: "update", items: [{ id: 1, text: "a", status: "done" }], nextId: 2 }),
		];
		expect(reconstructState(entries).items[0]!.status).toBe("done");
	});

	it("snapshot corrompido é pulado, anterior válido mantido", () => {
		const entries = [
			toolEntry({ action: "add", items: [{ id: 1, text: "a", status: "pending" }], nextId: 2 }),
			toolEntry("corrompido"),
			toolEntry({
				action: "add",
				items: [
					{ id: 1, text: "a", status: "in-progress" },
					{ id: 2, text: "b", status: "in-progress" },
				],
				nextId: 3,
			}),
		];
		const s = reconstructState(entries);
		expect(s.items).toHaveLength(1);
		expect(s.nextId).toBe(2);
	});

	it("só lê o branch passado — snapshots de outros branches não interferem", () => {
		// Simula /fork: o branch atual começa depois do snapshot abandonado.
		const branchAtual = [
			toolEntry({ action: "add", items: [{ id: 1, text: "novo", status: "pending" }], nextId: 2 }),
		];
		const s = reconstructState(branchAtual);
		expect(s.items[0]!.text).toBe("novo");
		expect(s.items).toHaveLength(1);
	});

	it("entrada custom (erro automático) mais recente vence", () => {
		const entries = [
			toolEntry({ action: "add", items: [{ id: 1, text: "a", status: "in-progress" }], nextId: 2 }),
			customEntry({ items: [{ id: 1, text: "a", status: "error", error: "falha em bash" }], nextId: 2 }),
		];
		expect(reconstructState(entries).items[0]!.status).toBe("error");
	});

	it("tool result posterior à custom vence (retomada do modelo)", () => {
		const entries = [
			customEntry({ items: [{ id: 1, text: "a", status: "error", error: "falha" }], nextId: 2 }),
			toolEntry({
				action: "update",
				items: [{ id: 1, text: "a", status: "in-progress" }],
				nextId: 2,
			}),
		];
		expect(reconstructState(entries).items[0]!.status).toBe("in-progress");
	});

	it("entrada custom corrompida é pulada", () => {
		const entries = [
			toolEntry({ action: "add", items: [{ id: 1, text: "a", status: "in-progress" }], nextId: 2 }),
			customEntry("corrompido"),
		];
		const s = reconstructState(entries);
		expect(s.items[0]!.status).toBe("in-progress");
	});
});
