/**
 * Testes da extensão pi-changelog — cenários de exibição.
 * Roda com: vitest run
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@earendil-works/pi-coding-agent", () => ({}));

import {
	runChangelogCommand,
	readConfig,
	resolveChangelogPath,
	readChangelog,
	expandTilde,
} from "../changelog.ts";

function makeExtDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cl-test-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}
function cleanup(dir: string) { rmSync(dir, { recursive: true, force: true }) }

interface Notify { msg: string; level: string }
function makeUi() {
	const notifications: Notify[] = [];
	return {
		ui: { notify: (msg: string, level = "info") => { notifications.push({ msg, level }) } },
		notifications,
	};
}
function makePi() {
	const entries: Array<{ type: string; data: unknown }> = [];
	return {
		entries,
		appendEntry: (type: string, data: unknown) => { entries.push({ type, data }) },
	};
}
function makeCtx() { const { ui, notifications } = makeUi(); return { ctx: { hasUI: false, ui }, notifications } }

describe("runChangelogCommand", () => {
	it("cenário 1: CHANGELOG.md existe → appendEntry com conteúdo", async () => {
		const extDir = makeExtDir();
		const p = join(extDir, "CHANGELOG.md");
		writeFileSync(p, "# Changelog\n\n## [1.0.0]\n");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: p }));
		const { ctx, notifications } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2]);
		expect(notifications).toHaveLength(0);
		expect(pi.entries).toHaveLength(1);
		expect(pi.entries[0].type).toBe("changelog-viewer");
		expect((pi.entries[0].data as { content: string }).content).toContain("## [1.0.0]");
		cleanup(extDir);
	});

	it("cenário 2: CHANGELOG.md não existe → warning", async () => {
		const extDir = makeExtDir();
		const p = join(extDir, "CHANGELOG.md");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: p }));
		const { ctx, notifications } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("warning");
		expect(notifications[0].msg).toContain("não encontrado");
		expect(pi.entries).toHaveLength(0);
		cleanup(extDir);
	});

	it("cenário 3: arquivo vazio → 'CHANGELOG vazio'", async () => {
		const extDir = makeExtDir();
		const p = join(extDir, "CHANGELOG.md");
		writeFileSync(p, "   \n  ");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: p }));
		const { ctx, notifications } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("info");
		expect(notifications[0].msg).toContain("vazio");
		expect(pi.entries).toHaveLength(0);
		cleanup(extDir);
	});

	it("cenário 4: config.json ausente → usa default path injetado", async () => {
		const extDir = makeExtDir();
		const defaultPath = join(extDir, "default", "CHANGELOG.md");
		mkdirSync(join(extDir, "default"));
		writeFileSync(defaultPath, "# Default\n");
		const { ctx, notifications } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2], defaultPath);
		expect(notifications).toHaveLength(0);
		expect(pi.entries).toHaveLength(1);
		expect((pi.entries[0].data as { content: string }).content).toContain("# Default");
		cleanup(extDir);
	});

	it("cenário 5: config.json com path customizado → respeita", async () => {
		const extDir = makeExtDir();
		const custom = join(extDir, "custom", "CHANGELOG.md");
		mkdirSync(join(extDir, "custom"));
		writeFileSync(custom, "# Custom\n");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: custom }));
		const { ctx, notifications } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2]);
		expect(notifications).toHaveLength(0);
		expect((pi.entries[0].data as { content: string }).content).toContain("# Custom");
		cleanup(extDir);
	});

	it("cenário 6: config.json inválido → avisa e usa default", async () => {
		const extDir = makeExtDir();
		writeFileSync(join(extDir, "config.json"), "{ quebrado");
		const { ctx, notifications } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2]);
		expect(notifications[0].level).toBe("warning");
		expect(notifications[0].msg).toContain("config.json inválido");
		// default path pode ou não existir — não assertamos contagem exata
		cleanup(extDir);
	});

	it("cenário 7: appendEntry chamado com tipo 'changelog-viewer' e conteúdo", async () => {
		const extDir = makeExtDir();
		const p = join(extDir, "CHANGELOG.md");
		writeFileSync(p, "# Changelog\n\n## [1.0.0]\n");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: p }));
		const { ctx } = makeCtx();
		const pi = makePi();
		await runChangelogCommand(ctx, extDir, pi as unknown as Parameters<typeof runChangelogCommand>[2]);
		expect(pi.entries).toHaveLength(1);
		expect(pi.entries[0].type).toBe("changelog-viewer");
		expect((pi.entries[0].data as { content: string }).content).toContain("# Changelog");
		cleanup(extDir);
	});
});

describe("expandTilde", () => {
	it("expande ~ no início, ~ sozinho, e mantém caminhos absolutos", () => {
		expect(expandTilde("~/x")).toBe(join(process.env.HOME!, "x"));
		expect(expandTilde("~")).toBe(process.env.HOME);
		expect(expandTilde("/abs/path")).toBe("/abs/path");
	});
});

describe("resolveChangelogPath", () => {
	it("usa default sem config e expande ~ com path custom", () => {
		expect(resolveChangelogPath(undefined)).toBe(join(process.env.HOME!, ".pi", "agent", "CHANGELOG.md"));
		expect(resolveChangelogPath("~/a/b.md").endsWith(join("a", "b.md"))).toBe(true);
	});
});

describe("readConfig", () => {
	it("ausente → default; campo vazio → default; válida → config", () => {
		const extDir = makeExtDir();
		expect(readConfig(extDir).config).toBeNull();
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: "   " }));
		expect(readConfig(extDir).config).toBeNull();
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: "~/c.md" }));
		expect(readConfig(extDir).config?.changelogPath).toBe("~/c.md");
		cleanup(extDir);
	});
});

describe("readChangelog", () => {
	it("ok, missing, erro de leitura", () => {
		const extDir = makeExtDir();
		const f = join(extDir, "c.md"); writeFileSync(f, "conteúdo");
		mkdirSync(join(extDir, "dir.md"));
		expect(readChangelog(f).kind).toBe("ok");
		expect(readChangelog(join(extDir, "nope.md")).kind).toBe("missing");
		expect(readChangelog(join(extDir, "dir.md")).kind).toBe("error");
		cleanup(extDir);
	});
});
