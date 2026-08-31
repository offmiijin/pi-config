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
		groups: [
			{
				id: "commit:abc123",
				label: "abc123 feat: altera app",
				kind: "commit",
				files: [{
					path: "src/components/very/long/path/app.ts",
					status: "M",
					additions: 12,
					deletions: 4,
					diff: "@@ -19,3 +19,4 @@",
					content: Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n"),
					changedLineRanges: [{ start: 20, end: 20 }],
				}],
			},
			{
				id: "working-tree",
				label: "Não commitadas",
				kind: "working-tree",
				files: [{
					path: "src/utils.ts",
					status: "A",
					additions: 3,
					deletions: 0,
					diff: "@@ -0,0 +1,3 @@",
					content: "const created = true;",
					changedLineRanges: [{ start: 1, end: 3 }],
				}],
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

	it("exibe commits recolhidos e arquivos não commitados normalmente", () => {
		const { panel } = setup();
		const body = panel.render(100).join("\n");
		expect(body).toContain("abc123");
		expect(body).not.toContain("app.ts");
		expect(body).toContain("src/utils.ts");
		expect(body).toContain("Não commitadas");
	});

	it("expande o commit selecionado e permite selecionar seus arquivos", () => {
		const { panel } = setup();
		panel.handleInput("\r");
		let body = panel.render(100).join("\n");
		expect(body).toContain("app.ts");
		expect(body).not.toContain("line-20");

		panel.handleInput("\x1b[B");
		body = panel.render(100).join("\n");
		expect(body).toContain("line-20");
		for (const line of panel.render(100)) expect(visibleWidth(line)).toBe(100);
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
	it("setas e J/K para cima/baixo selecionam commits e arquivos", () => {
		const { panel, calls } = setup();
		panel.handleInput("\x1b[B");
		const selected = panel.render(100).join("\n");
		expect(selected).toContain("const created = true;");
		expect(selected).not.toContain("line-20");
		expect(calls.length).toBeGreaterThan(0);

		panel.handleInput("k");
		expect(panel.render(100).join("\n")).not.toContain("line-20");
		panel.handleInput("\r");
		panel.handleInput("J");
		expect(panel.render(100).join("\n")).toContain("line-20");
	});

	it("Enter move o foco para o arquivo e F alterna todas as linhas", () => {
		const { panel } = setup();
		panel.handleInput("\r");
		panel.handleInput("J");
		panel.handleInput("\r");
		expect(panel.render(100).join("\n")).toContain("rolar arquivo");

		panel.handleInput("J");
		panel.handleInput("J");
		const scrolled = panel.render(100).join("\n");
		expect(scrolled).not.toContain("│ toolDiffContext:line-10");
		expect(scrolled).toContain("line-21");

		panel.handleInput("F");
		const fullFile = panel.render(100).join("\n");
		expect(fullFile).toContain("line-1");
		expect(fullFile).toContain("F contexto");

		panel.handleInput("f");
		expect(panel.render(100).join("\n")).not.toContain("│dim: 1 │ toolDiffContext:line-1");

		panel.handleInput("\x1b[D");
		expect(panel.render(100).join("\n")).toContain("Enter arquivo");
	});

	it("rola a lista da coluna direita até o item selecionado", () => {
		const files = Array.from({ length: 10 }, (_, index) => ({
			path: `src/file-${String(index + 1).padStart(2, "0")}.ts`,
			status: "M" as const,
			additions: 1,
			deletions: 0,
			diff: "@@ -1 +1 @@",
			content: `const file = ${index + 1};`,
			changedLineRanges: [{ start: 1, end: 1 }],
		}));
		const tui = { terminal: { rows: 20 }, requestRender: () => {} } as any;
		const panel = new ChangesPanel(tui, fakeTheme(), {
			groups: [{ id: "commit:many", label: "many arquivos", kind: "commit", files }],
			totalAdditions: 10,
			totalDeletions: 0,
		}, () => {});

		panel.handleInput("\r");
		for (let index = 0; index < files.length; index++) panel.handleInput("j");
		const body = panel.render(100).join("\n");
		expect(body).toContain("src/file-10.ts");
		expect(body).not.toContain("src/file-01.ts");
	});

	it("Esc chama o fechamento", () => {
		let closed = false;
		const tui = { terminal: { rows: 20 }, requestRender: () => {} } as any;
		const panel = new ChangesPanel(tui, fakeTheme(), snapshot(), () => { closed = true; });
		panel.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
