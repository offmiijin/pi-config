import { describe, expect, it } from "vitest";
import { buildCompletionReport, isComplete, statusColor } from "../render.ts";

describe("render — statusColor", () => {
	it("mapeia cada status e usa warning (nunca vermelho) para error", () => {
		expect(statusColor("pending")).toBe("muted");
		expect(statusColor("in-progress")).toBe("warning");
		expect(statusColor("done")).toBe("success");
		expect(statusColor("error")).toBe("warning");
	});

	it("status desconhecido (runtime) cai para muted em vez de undefined", () => {
		expect(statusColor("banana" as never)).toBe("muted");
	});
});

describe("render — resumo final", () => {
	it("buildCompletionReport lista todas as tarefas com cabeçalho e resumo", () => {
		const report = buildCompletionReport([
			{ id: 1, text: "a", status: "done" },
			{ id: 2, text: "b", status: "done" },
		]);
		expect(report).toContain("todas as 2 tarefa(s) concluídas");
		expect(report).toContain("#1 a");
		expect(report).toContain("#2 b");
		expect(report).toContain("Resumo: 2 concluída(s)");
	});

	it("isComplete exige lista não vazia e tudo done", () => {
		expect(isComplete([])).toBe(false);
		expect(isComplete([{ id: 1, text: "a", status: "pending" }])).toBe(false);
		expect(
			isComplete([
				{ id: 1, text: "a", status: "done" },
				{ id: 2, text: "b", status: "error", error: "x" },
			]),
		).toBe(false);
		expect(
			isComplete([
				{ id: 1, text: "a", status: "done" },
				{ id: 2, text: "b", status: "done" },
			]),
		).toBe(true);
	});
});
