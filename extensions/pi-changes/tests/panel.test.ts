import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ChangesPanel, truncatePathFromLeft } from "../panel.ts";
import type { ChangesSnapshot } from "../types.ts";

function fakeTheme() {
	return {
		fg: (color: string, text: string) => `${color}:${text}`,
		bg: (color: string, text: string) => `${color}[${text}]`,
		bold: (text: string) => `**${text}**`,
	} as any;
}

function snapshot(): ChangesSnapshot {
	return {
		files: [
			{
				path: "src/components/very/long/path/app.ts",
				status: "M",
				additions: 12,
				deletions: 4,
				diff: "diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-old\n+new",
			},
			{
				path: "src/utils.ts",
				status: "A",
				additions: 3,
				deletions: 0,
				diff: "diff --git a/utils.ts b/utils.ts\n+created",
			},
		],
		totalAdditions: 15,
		totalDeletions: 4,
	};
}

function setup() {
	const calls: number[] = [];
	const tui = {
		terminal: { rows: 20 },
		requestRender: () => calls.push(1),
	} as any;
	const panel = new ChangesPanel(tui, fakeTheme(), snapshot(), () => {});
	return { panel, calls };
}

describe("painel — truncamento e layout", () => {
	it("corta o caminho pela esquerda e preserva o sufixo", () => {
		const value = truncatePathFromLeft("src/components/very/long/path/app.js", 12);
		expect(value.startsWith("…")).toBe(true);
		expect(value.endsWith("app.js")).toBe(true);
		expect(visibleWidth(value)).toBeLessThanOrEqual(12);
	});

	it("renderiza o diff à esquerda e metadados em uma coluna menor à direita", () => {
		const { panel } = setup();
		const lines = panel.render(100);
		const body = lines.join("\n");
		expect(body).toContain("+new");
		expect(body).toContain("+12");
		expect(body).toContain("-4");
		expect(body).toContain("app.ts");
		for (const line of lines) expect(visibleWidth(line)).toBe(100);
	});

	it("mantém a divisória dentro da moldura e alinha os cantos laterais", () => {
		const { panel } = setup();
		const lines = panel.render(160);

		expect(lines[0]!.startsWith("╭")).toBe(true);
		expect(lines[0]!.endsWith("╮")).toBe(true);
		expect(lines[2]!.startsWith("├")).toBe(true);
		expect(lines[2]!.endsWith("┤")).toBe(true);
		expect(lines[2]!).toContain("┬");
		expect(lines[2]!).not.toContain("┼");
		expect(lines.at(-1)!.startsWith("╰")).toBe(true);
		expect(lines.at(-1)!.endsWith("╯")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBe(160);
	});
});

describe("painel — seleção", () => {
	it("setas para cima/baixo selecionam arquivos e trocam o diff", () => {
		const { panel, calls } = setup();
		panel.handleInput("\x1b[B");
		const selected = panel.render(100).join("\n");
		expect(selected).toContain("+created");
		expect(selected).not.toContain("+new");
		expect(calls.length).toBeGreaterThan(0);

		panel.handleInput("\x1b[A");
		expect(panel.render(100).join("\n")).toContain("+new");
	});

	it("Esc chama o fechamento", () => {
		let closed = false;
		const tui = { terminal: { rows: 20 }, requestRender: () => {} } as any;
		const panel = new ChangesPanel(tui, fakeTheme(), snapshot(), () => { closed = true; });
		panel.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
