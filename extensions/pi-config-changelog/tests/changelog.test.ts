/**
 * Testes da extensão pi-config-changelog — cenários de exibição.
 *
 * Roda com: vitest run
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	runChangelogCommand,
	readConfig,
	resolveChangelogPath,
	readChangelog,
	expandTilde,
} from "../changelog.js";

/** Cria dir temporário (fingindo ser a pasta da extensão) e retorna path. */
function makeExtDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cl-test-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanup(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}

interface Notify {
	msg: string;
	level: string;
}

type NotifyFn = (msg: string, level?: "info" | "warning" | "error") => void;

function makeUi() {
	const notifications: Notify[] = [];
	const ui: { notify: NotifyFn } = {
		notify: (msg, level) => {
			notifications.push({ msg, level: level ?? "info" });
		},
	};
	return { ui, notifications };
}

describe("runChangelogCommand", () => {
	it("cenário 1: CHANGELOG.md existe → exibe conteúdo (info)", async () => {
		const extDir = makeExtDir();
		const changelogPath = join(extDir, "CHANGELOG.md");
		writeFileSync(changelogPath, "# Changelog\n\n## [1.0.0]\n");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath }));
		const { ui, notifications } = makeUi();

		await runChangelogCommand(extDir, ui);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("info");
		expect(notifications[0].msg).toContain("## [1.0.0]");
		cleanup(extDir);
	});

	it("cenário 2: CHANGELOG.md não existe → warning 'não encontrado'", async () => {
		const extDir = makeExtDir();
		const changelogPath = join(extDir, "CHANGELOG.md"); // não cria
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath }));
		const { ui, notifications } = makeUi();

		await runChangelogCommand(extDir, ui);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("warning");
		expect(notifications[0].msg).toContain("não encontrado");
		cleanup(extDir);
	});

	it("cenário 3: arquivo vazio → 'CHANGELOG vazio' (info)", async () => {
		const extDir = makeExtDir();
		const changelogPath = join(extDir, "CHANGELOG.md");
		writeFileSync(changelogPath, "   \n  ");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath }));
		const { ui, notifications } = makeUi();

		await runChangelogCommand(extDir, ui);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("info");
		expect(notifications[0].msg).toContain("vazio");
		cleanup(extDir);
	});

	it("cenário 4: config.json ausente → usa default path injetado", async () => {
		const extDir = makeExtDir();
		const defaultPath = join(extDir, "default", "CHANGELOG.md");
		mkdirSync(join(extDir, "default"));
		writeFileSync(defaultPath, "# Default\n");
		const { ui, notifications } = makeUi();

		await runChangelogCommand(extDir, ui, defaultPath);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("info");
		expect(notifications[0].msg).toContain("# Default");
		cleanup(extDir);
	});

	it("cenário 5: config.json com path customizado → respeita", async () => {
		const extDir = makeExtDir();
		const custom = join(extDir, "custom", "CHANGELOG.md");
		mkdirSync(join(extDir, "custom"));
		writeFileSync(custom, "# Custom\n");
		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: custom }));
		const { ui, notifications } = makeUi();

		await runChangelogCommand(extDir, ui);

		expect(notifications[0].level).toBe("info");
		expect(notifications[0].msg).toContain("# Custom");
		cleanup(extDir);
	});

	it("cenário 6: config.json inválido → avisa e usa default", async () => {
		const extDir = makeExtDir();
		writeFileSync(join(extDir, "config.json"), "{ quebrado");
		const { ui, notifications } = makeUi();

		await runChangelogCommand(extDir, ui);

		expect(notifications).toHaveLength(2);
		expect(notifications[0].level).toBe("warning");
		expect(notifications[0].msg).toContain("config.json inválido");
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
		expect(resolveChangelogPath(undefined)).toBe(
			join(process.env.HOME!, ".pi", "agent", "CHANGELOG.md"),
		);
		expect(resolveChangelogPath("~/a/b.md").endsWith(join("a", "b.md"))).toBe(true);
	});
});

describe("readConfig", () => {
	it("ausente → default; campo vazio → default; válida → config", () => {
		const extDir = makeExtDir();

		let r = readConfig(extDir);
		expect(r.config).toBeNull();
		expect(r.configError).toBeNull();

		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: "   " }));
		r = readConfig(extDir);
		expect(r.config).toBeNull();
		expect(r.configError).toBeNull();

		writeFileSync(join(extDir, "config.json"), JSON.stringify({ changelogPath: "~/c.md" }));
		r = readConfig(extDir);
		expect(r.config?.changelogPath).toBe("~/c.md");
		expect(r.configError).toBeNull();
		cleanup(extDir);
	});
});

describe("readChangelog", () => {
	it("ok, missing, erro de leitura", () => {
		const extDir = makeExtDir();
		const f = join(extDir, "c.md");
		writeFileSync(f, "conteúdo");
		mkdirSync(join(extDir, "dir.md"));

		expect(readChangelog(f).kind).toBe("ok");
		expect(readChangelog(join(extDir, "nope.md")).kind).toBe("missing");
		expect(readChangelog(join(extDir, "dir.md")).kind).toBe("error");
		cleanup(extDir);
	});
});
