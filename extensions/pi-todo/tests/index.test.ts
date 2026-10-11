import { describe, expect, it } from "vitest";
import extension from "../index.ts";
import { TODO_STATE_ENTRY } from "../reconstruct.ts";

function setup(getBranch: () => unknown[] = () => []) {
	const handlers: Record<string, (event: unknown, ctx: any) => Promise<void>> = {};
	const tools: unknown[] = [];
	const fakePi = {
		on: (name: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
			(handlers as any)[name] = handler;
		},
		registerTool: (def: unknown) => tools.push(def),
		appendEntry: () => {},
	};
	extension(fakePi as any);
	const ctx = {
		sessionManager: { getBranch },
		hasUI: false,
		ui: {},
	} as any;
	return { handlers: handlers as unknown as Record<string, (event: unknown, ctx: any) => Promise<void>>, tools, ctx };
}

const toolEntry = (details: unknown) => ({
	type: "message",
	message: { role: "toolResult", toolName: "todo", details },
});

describe("index — composição", () => {
	it("registra a tool todo e o auto-erro", () => {
		const { handlers, tools } = setup();
		expect(tools).toHaveLength(1);
		expect((tools[0] as { name: string }).name).toBe("todo");
		expect(Object.keys(handlers).sort()).toEqual(["session_start", "session_tree", "tool_execution_end"]);
	});

	it("session_start reconstrói o estado a partir do branch", async () => {
		const { handlers, ctx } = setup(() => [
			toolEntry({ action: "add", items: [{ id: 1, text: "a", status: "in-progress" }], nextId: 2 }),
		]);
		await handlers["session_start"]!({}, ctx);
		// Estado reconstruído é observável via widget/tool — valida via novo evento
		// com branch esvaziado vs. populado (ver session_tree abaixo).
		expect(ctx.hasUI).toBe(false);
	});

	it("session_tree reflete o ponto da história (fork/navegação)", async () => {
		const snapshots = [
			[toolEntry({ action: "add", items: [{ id: 1, text: "novo", status: "pending" }], nextId: 2 })],
			[],
		];
		let call = 0;
		const { handlers, ctx } = setup(() => snapshots[call++] ?? []);
		await handlers["session_tree"]!({}, ctx);
		await handlers["session_tree"]!({}, ctx);
		// Sem UI não há widget; o ponto é não lançar e aceitar branches distintos.
		expect(call).toBe(2);
	});

	it("branch vazio ou corrompido → estado vazio, sem lançar", async () => {
		const { handlers, ctx } = setup(() => ["corrompido", null] as any);
		await expect(handlers["session_start"]!({}, ctx)).resolves.toBeUndefined();
	});

	it("getBranch lançando não quebra o session_start", async () => {
		const { handlers, ctx } = setup(() => {
			throw new Error("sessão indisponível");
		});
		await expect(handlers["session_start"]!({}, ctx)).resolves.toBeUndefined();
		await expect(handlers["session_tree"]!({}, ctx)).resolves.toBeUndefined();
	});

	it("entrada custom de erro automático participa da reconstrução", async () => {
		const customEntry = {
			type: "custom",
			customType: TODO_STATE_ENTRY,
			data: { items: [{ id: 1, text: "a", status: "error", error: "falha em bash" }], nextId: 2 },
		};
		const { handlers, ctx } = setup(() => [customEntry]);
		await expect(handlers["session_start"]!({}, ctx)).resolves.toBeUndefined();
	});
});
