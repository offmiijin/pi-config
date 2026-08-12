import { describe, expect, it } from "vitest";
import { createTodoState, type TodoToolState } from "../state.ts";
import { registerTodoTool, type TodoParamsInput } from "../tools.ts";
import type { TodoDetails } from "../types.ts";

function fakeTheme() {
	const fg = (color: string, text: string) => `${color}:${text}`;
	return { fg, bold: (t: string) => `**${t}**` } as any;
}

interface CapturedTool {
	name: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	executionMode: string;
	parameters: any;
	execute: (
		id: string,
		params: TodoParamsInput,
		signal: any,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: { type: "text"; text: string }[]; details: TodoDetails }>;
	renderCall: (args: any, theme: any) => any;
	renderResult: (result: any, options: any, theme: any) => any;
}

function setup() {
	const holder: TodoToolState = { value: createTodoState() };
	const defs: CapturedTool[] = [];
	const fakePi = { registerTool: (d: CapturedTool) => defs.push(d) };
	registerTodoTool(fakePi as any, holder);
	return { holder, tool: defs[0]! };
}

// ctx mínimo: hasUI false → updateTodoWidget vira no-op (como em modo print).
const noUiCtx = { hasUI: false } as any;

const renderText = (comp: any) => comp.render(200).join("\n");

describe("tool — definição", () => {
	it("schema define action, texts, id, status, error", () => {
		const { tool } = setup();
		expect(tool.name).toBe("todo");
		expect(Object.keys(tool.parameters.properties).sort()).toEqual([
			"action",
			"error",
			"id",
			"status",
			"texts",
		]);
	});

	it("enums usam shape de string enum (compatível Google)", () => {
		const { tool } = setup();
		expect(tool.parameters.properties.action.enum).toEqual(["list", "add", "update", "clear"]);
		expect(tool.parameters.properties.status.enum).toEqual([
			"pending",
			"in-progress",
			"done",
			"error",
		]);
	});

	it("executa em modo sequencial (evita corrida entre irmãs)", () => {
		const { tool } = setup();
		expect(tool.executionMode).toBe("sequential");
	});

	it("promptSnippet e promptGuidelines presentes", () => {
		const { tool } = setup();
		expect(tool.promptSnippet).toContain("to-do");
		expect(tool.promptGuidelines.length).toBeGreaterThanOrEqual(5);
		for (const g of tool.promptGuidelines) {
			expect(g).toMatch(/\btodo\b/); // regra do pi: nomear a ferramenta
		}
	});
});

describe("tool — execute e snapshot em details", () => {
	it("add: mensagem ao modelo + snapshot completo em details + holder atualizado", async () => {
		const { holder, tool } = setup();
		const r = await tool.execute("1", { action: "add", texts: ["a", "b"] }, undefined, undefined, noUiCtx);
		expect(r.content[0]!.text).toContain("Adicionadas 2 tarefa(s)");
		expect(r.details.items).toHaveLength(2);
		expect(r.details.nextId).toBe(3);
		expect(r.details.error).toBeUndefined();
		expect(holder.value.items).toHaveLength(2);
	});

	it("update: cada status retorna snapshot coerente", async () => {
		const { holder, tool } = setup();
		await tool.execute("1", { action: "add", texts: ["a"] }, undefined, undefined, noUiCtx);
		const r = await tool.execute("2", { action: "update", id: 1, status: "error", error: "x" }, undefined, undefined, noUiCtx);
		expect(r.content[0]!.text).toBe("Tarefa #1 → error: x");
		expect(r.details.items[0]).toEqual({ id: 1, text: "a", status: "error", error: "x" });
		expect(holder.value.items[0]!.status).toBe("error");
	});

	it("erro de operação mantém snapshot do estado ATUAL (não perde estado)", async () => {
		const { holder, tool } = setup();
		await tool.execute("1", { action: "add", texts: ["a"] }, undefined, undefined, noUiCtx);
		const r = await tool.execute("2", { action: "update", id: 99, status: "done" }, undefined, undefined, noUiCtx);
		expect(r.details.error).toBeDefined();
		expect(r.details.items).toHaveLength(1);
		expect(r.content[0]!.text).toContain("Erro:");
		expect(holder.value.items).toHaveLength(1);
	});

	it("add vazio → erro sem mutação", async () => {
		const { holder, tool } = setup();
		const r = await tool.execute("1", { action: "add", texts: [] }, undefined, undefined, noUiCtx);
		expect(r.details.error).toBeDefined();
		expect(holder.value.items).toHaveLength(0);
	});

	it("list: texto com status por item", async () => {
		const { tool } = setup();
		await tool.execute("1", { action: "add", texts: ["a"] }, undefined, undefined, noUiCtx);
		const r = await tool.execute("2", { action: "list" }, undefined, undefined, noUiCtx);
		expect(r.content[0]!.text).toContain("#1 [pending] a");
	});

	it("clear: zera e informa quantidade", async () => {
		const { holder, tool } = setup();
		await tool.execute("1", { action: "add", texts: ["a", "b"] }, undefined, undefined, noUiCtx);
		const r = await tool.execute("2", { action: "clear" }, undefined, undefined, noUiCtx);
		expect(r.content[0]!.text).toContain("Lista limpa (2");
		expect(holder.value.items).toHaveLength(0);
		expect(r.details.nextId).toBe(1);
	});

	it("ação desconhecida → erro", async () => {
		const { tool } = setup();
		const r = await tool.execute("1", { action: "banana" } as any, undefined, undefined, noUiCtx);
		expect(r.details.error).toBeDefined();
	});
});

describe("tool — renderização", () => {
	it("renderCall mostra ação", () => {
		const { tool } = setup();
		expect(renderText(tool.renderCall({ action: "add", texts: ["x"] }, fakeTheme()))).toContain("todo");
	});

	it("renderResult list colapsado limita a 5 com indicador; expandido mostra tudo", async () => {
		const { tool } = setup();
		await tool.execute("1", { action: "add", texts: ["1", "2", "3", "4", "5", "6"] }, undefined, undefined, noUiCtx);
		const r = await tool.execute("2", { action: "list" }, undefined, undefined, noUiCtx);
		const collapsed = renderText(tool.renderResult(r, { expanded: false }, fakeTheme()));
		expect(collapsed).toContain("... 1 mais");
		const expanded = renderText(tool.renderResult(r, { expanded: true }, fakeTheme()));
		expect(expanded).not.toContain("...");
	});

	it("renderResult com erro de operação → vermelho", async () => {
		const { tool } = setup();
		const r = await tool.execute("1", { action: "add", texts: [] }, undefined, undefined, noUiCtx);
		expect(renderText(tool.renderResult(r, { expanded: false }, fakeTheme()))).toContain("error:Erro:");
	});
});
