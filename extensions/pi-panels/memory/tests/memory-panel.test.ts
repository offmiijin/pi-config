import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterEntries, listAvailableProjects, MemoryStore, readMemoryPreview } from "../data.ts";
import { formatUpdated, MemoryDetailsPanel, MemoryPanel } from "../panel.ts";
import { shouldToggleMemoryPanel } from "../index.ts";
import type { MemoryEntry } from "../types.ts";

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
	return {
		scope: "global",
		type: "decisions",
		context: "ctx",
		title: "titulo",
		excerpt: "trecho",
		confidence: 0.8,
		updated: "2026-10-25T00:00:00.000Z",
		path: "_global/decisions/ctx.md",
		...overrides,
	};
}

describe("painel de memórias", () => {
	it("filtra por escopo, tipo e busca", () => {
		const entries = [
			makeEntry({ scope: "global", type: "decisions", context: "cache", title: "Cache da sessão" }),
			makeEntry({ scope: "project", type: "gotchas", context: "login", title: "Loop de login" }),
		];
		expect(filterEntries(entries, { scope: "global", type: "all", search: "" })).toHaveLength(1);
		expect(filterEntries(entries, { scope: "all", type: "gotchas", search: "" })[0]?.context).toBe("login");
		expect(filterEntries(entries, { scope: "all", type: "all", search: "cache" })[0]?.scope).toBe("global");
		expect(filterEntries(entries, { scope: "all", type: "all", search: "inexistente" })).toHaveLength(0);
	});

	it("lista projetos e lê memórias globais + projeto", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-panel-"));
		mkdirSync(join(root, "_global", "decisions"), { recursive: true });
		mkdirSync(join(root, "projects", "demo", "gotchas"), { recursive: true });
		mkdirSync(join(root, "projects", "outro", "decisions"), { recursive: true });
		writeFileSync(
			join(root, "_global", "decisions", "cache.md"),
			'---\nconfidence: 0.9\nupdated: "2026-10-25T00:00:00.000Z"\nsummary: resumo global\n---\n# Cache\nconteudo global\n',
		);
		writeFileSync(
			join(root, "projects", "demo", "gotchas", "login.md"),
			'---\nconfidence: 0.7\nupdated: "2026-10-24T00:00:00.000Z"\n---\n# Login\nconteudo projeto\n',
		);

		expect(listAvailableProjects(root).sort()).toEqual(["demo", "outro"]);
		const store = new MemoryStore(root);
		const snapshot = store.snapshot("demo", { scope: "all", type: "all", search: "" });
		expect(snapshot.totals).toEqual({ global: 1, project: 1 });
		expect(snapshot.entries.map((e) => e.context).sort()).toEqual(["cache", "login"]);

		const onlyProject = store.snapshot("demo", { scope: "project", type: "all", search: "" });
		expect(onlyProject.entries.map((e) => e.context)).toEqual(["login"]);
	});

	it("preview lê o conteúdo completo sem corte", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-preview-"));
		mkdirSync(join(root, "_global", "decisions"), { recursive: true });
		const big = `# Titulo\n${"linha de conteudo\n".repeat(500)}`;
		writeFileSync(join(root, "_global", "decisions", "big.md"), big);
		expect(readMemoryPreview(root, "_global/decisions/big.md")).toBe(big);
	});

	it("preview do painel respeita o limite do painel e navega com j/k", () => {
		const preview = Array.from({ length: 100 }, (_, i) => `linha ${i}`).join("\n");
		const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as import("@earendil-works/pi-tui").TUI;
		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as import("@earendil-works/pi-coding-agent").Theme;
		const panel = new MemoryDetailsPanel(tui, theme, makeEntry({}), preview, () => {});
		const first = panel.render(80);
		// Limite do painel: 90% de 24 linhas.
		expect(first.length).toBeLessThanOrEqual(Math.floor(24 * 0.9));
		panel.handleInput("j");
		const second = panel.render(80);
		expect(second).not.toEqual(first);
		panel.handleInput("k");
		expect(panel.render(80)).toEqual(first);
	});

	it("colunas de dados ficam sob os títulos mesmo com nome longo", () => {
		const longEntry = makeEntry({
			scope: "project",
			type: "decisions",
			context: "um-contexto-muito-longo-que-ultrapassa-a-largura-disponivel-da-coluna",
			title: "um título também muito longo para forçar o corte antes da coluna Conf",
			confidence: 0.85,
			updated: "2026-10-25T00:00:00.000Z",
		});
		const snapshot = {
			generatedAt: Date.now(),
			projectId: "demo",
			availableProjects: ["demo"],
			query: { scope: "all" as const, type: "all" as const, search: "" },
			entries: [makeEntry({}), longEntry],
			totals: { global: 1, project: 1 },
		};
		const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as import("@earendil-works/pi-tui").TUI;
		const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v } as unknown as import("@earendil-works/pi-coding-agent").Theme;
		const panel = new MemoryPanel(tui, theme, snapshot, {
			onQueryChange: () => {},
			onRefresh: () => {},
			onClose: () => {},
			onPreview: () => {},
			onSearch: () => {},
		});
		// truncateToWidth anexa reset ANSI ao truncar: comparar largura visível.
		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		const lines = panel.render(100).map(stripAnsi);
		const header = lines.find((l) => l.includes("Escopo") && l.includes("Memória"));
		expect(header).toBeDefined();
		const rows = lines.filter((l) => l.includes("GLOBAL") || l.includes("PROJETO"));
		expect(rows).toHaveLength(2);
		// Todas as linhas de dados têm a mesma largura visível do cabeçalho.
		for (const row of rows) expect(row.length).toBe(header!.length);
		// Conf e data de cada linha caem sob os títulos.
		for (const row of rows) {
			expect(row.indexOf("0.85") >= 0 || row.indexOf("0.80") >= 0).toBe(true);
			const conf = row.includes("0.85") ? "0.85" : "0.80";
			expect(row.indexOf(conf)).toBe(header!.indexOf("Conf"));
			const date = formatUpdated("2026-10-25T00:00:00.000Z");
			expect(row.indexOf(date)).toBe(header!.indexOf("Atual."));
		}
	});

	it("preview quebra por palavra sem cortar no meio", () => {
		const paragraph = "Para o debounce, valide o par (entrada bruta, timestamp) para garantir que repeticoes sejam ignoradas dentro da janela";
		const tui = { terminal: { rows: 60 }, requestRender() {} } as unknown as import("@earendil-works/pi-tui").TUI;
		const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v } as unknown as import("@earendil-works/pi-coding-agent").Theme;
		const panel = new MemoryDetailsPanel(tui, theme, makeEntry({}), paragraph, () => {});
		const stripAnsi = (v: string) => v.replace(/\x1b\[[0-9;]*m/g, "");
		const lines = panel.render(60).map(stripAnsi);
		const firstSep = lines.findIndex((l) => l.includes("├"));
		const lastSep = lines.map((l) => l.includes("├")).lastIndexOf(true);
		const body = lines.slice(firstSep + 1, lastSep).map((l) => l.slice(1, -1).trim());
		// Quebrou em mais de uma linha visual, sem estourar a largura útil (57).
		expect(body.length).toBeGreaterThan(1);
		for (const line of body) expect(line.length).toBeLessThanOrEqual(57);
		// Nenhuma palavra foi cortada no meio e nada foi descartado.
		for (const word of paragraph.split(" ")) {
			expect(body.some((l) => l.split(" ").includes(word))).toBe(true);
		}
		expect(body.join(" ")).toBe(paragraph);
	});

	it("filtros alternam o campo com h/l e setas; cima/baixo nao trocam", () => {
		const base = {
			generatedAt: Date.now(),
			projectId: "demo",
			availableProjects: ["demo"],
			entries: [makeEntry({})],
			totals: { global: 1, project: 0 },
		};
		let current: import("../types.ts").MemoryQuery = { scope: "all", type: "all", search: "" };
		const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as import("@earendil-works/pi-tui").TUI;
		const theme = { fg: (_c: string, v: string) => v, bold: (v: string) => v } as unknown as import("@earendil-works/pi-coding-agent").Theme;
		const panel = new MemoryPanel(tui, theme, { ...base, query: current }, {
			onQueryChange: (q) => { current = q; panel.setSnapshot({ ...base, query: q }); },
			onRefresh: () => {},
			onClose: () => {},
			onPreview: () => {},
			onSearch: () => {},
		});
		const enter = "\r";
		const right = "\x1b[C";
		const left = "\x1b[D";
		const up = "\x1b[A";
		panel.handleInput("\t"); // Tab: conteudo -> filtros (foco em Escopo)
		panel.handleInput("l"); // foco -> Tipo
		panel.handleInput(enter);
		expect(current).toMatchObject({ scope: "all", type: "_rules" });
		panel.handleInput("h"); // foco -> Escopo
		panel.handleInput(enter);
		expect(current).toMatchObject({ scope: "global", type: "_rules" });
		panel.handleInput(right); // foco -> Tipo
		panel.handleInput(enter);
		expect(current).toMatchObject({ scope: "global", type: "decisions" });
		panel.handleInput(left); // foco -> Escopo
		panel.handleInput("j"); // baixo nao troca de campo
		panel.handleInput(enter);
		expect(current).toMatchObject({ scope: "project", type: "decisions" });
		panel.handleInput(up); // cima nao troca de campo
		panel.handleInput(enter);
		expect(current).toMatchObject({ scope: "all", type: "decisions" });
	});

	it("respeita debounce do Alt+G", () => {
		// Alt+G em terminal legacy = ESC + g.
		const toggle = "\x1bg";
		expect(shouldToggleMemoryPanel(toggle, 1000, Number.NEGATIVE_INFINITY)).toBe(true);
		expect(shouldToggleMemoryPanel(toggle, 1100, 1000)).toBe(false);
		expect(shouldToggleMemoryPanel("\x1bm", 2000, 0)).toBe(false);
	});
});
