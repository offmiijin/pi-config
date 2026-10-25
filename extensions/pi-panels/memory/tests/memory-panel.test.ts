import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterEntries, listAvailableProjects, MemoryStore, readMemoryPreview } from "../data.ts";
import { MemoryDetailsPanel } from "../panel.ts";
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

	it("respeita debounce do Alt+G", () => {
		// Alt+G em terminal legacy = ESC + g.
		const toggle = "\x1bg";
		expect(shouldToggleMemoryPanel(toggle, 1000, Number.NEGATIVE_INFINITY)).toBe(true);
		expect(shouldToggleMemoryPanel(toggle, 1100, 1000)).toBe(false);
		expect(shouldToggleMemoryPanel("\x1bm", 2000, 0)).toBe(false);
	});
});
