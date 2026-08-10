/**
 * pi-config-changelog — Exibe o CHANGELOG.md da versão atual do pi-config.
 *
 * Comando: /pi-config-changelog
 *   Lê o CHANGELOG.md (raiz do repositório, default ~/.pi/agent/CHANGELOG.md)
 *   e exibe o conteúdo no chat. Caminho pode ser sobrescrito em config.json
 *   (changelogPath) na mesma pasta da extensão.
 *
 * Convenção do arquivo:
 *   - Branch != main: seção [x.y.z] (última versão lançada) + ## Unreleased
 *   - Na main (release): apenas [x.y.z], sem Unreleased
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CHANGELOG_PATH = join(homedir(), ".pi", "agent", "CHANGELOG.md");
const CONFIG_FILE = "config.json";

interface Config {
	changelogPath: string;
}

type ReadResult =
	| { kind: "ok"; content: string }
	| { kind: "missing" }
	| { kind: "error"; error: string };

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pi-config-changelog", {
		description: "Mostra o changelog da versão atual do pi-config",
		handler: async (_args, ctx) => {
			await runChangelogCommand(getExtensionDir(), ctx.ui);
		},
	});
}

/**
 * Lógica do comando, isolada com UI e default path injetáveis para testes.
 */
export async function runChangelogCommand(
	extDir: string,
	ui: Pick<ExtensionContext["ui"], "notify">,
	defaultPath: string = DEFAULT_CHANGELOG_PATH,
): Promise<void> {
	const { config, configError } = readConfig(extDir);
	if (configError) {
		ui.notify(`⚠️ ${configError} — usando caminho padrão.`, "warning");
	}

	const changelogPath = resolveChangelogPath(config?.changelogPath, defaultPath);
	const result = readChangelog(changelogPath);

	switch (result.kind) {
		case "missing":
			ui.notify(`❌ CHANGELOG.md não encontrado em ${changelogPath}`, "warning");
			return;
		case "error":
			ui.notify(`❌ Erro ao ler CHANGELOG.md: ${result.error}`, "error");
			return;
	}

	if (result.content.trim() === "") {
		ui.notify("📭 CHANGELOG vazio.", "info");
		return;
	}
	ui.notify(result.content, "info");
}

// ── Caminhos ──────────────────────────────────────────────────────────

export function getExtensionDir(): string {
	const dir = (import.meta as { dirname?: string }).dirname;
	return dir ?? dirname(fileURLToPath(import.meta.url));
}

export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function resolveChangelogPath(
	configured?: string,
	defaultPath: string = DEFAULT_CHANGELOG_PATH,
): string {
	if (!configured || configured.trim() === "") return defaultPath;
	return resolve(expandTilde(configured.trim()));
}

// ── Config ────────────────────────────────────────────────────────────

export function readConfig(
	extDir: string,
): { config: Config | null; configError: string | null } {
	const configPath = join(extDir, CONFIG_FILE);
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch {
		// Sem config.json → usa padrão, sem aviso
		return { config: null, configError: null };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<Config>;
		if (
			parsed &&
			typeof parsed.changelogPath === "string" &&
			parsed.changelogPath.trim() !== ""
		) {
			return { config: { changelogPath: parsed.changelogPath }, configError: null };
		}
		return { config: null, configError: null };
	} catch {
		return { config: null, configError: "config.json inválido" };
	}
}

// ── Leitura ───────────────────────────────────────────────────────────

export function readChangelog(path: string): ReadResult {
	try {
		return { kind: "ok", content: readFileSync(path, "utf-8") };
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return { kind: "missing" };
		}
		const msg = err instanceof Error ? err.message : String(err);
		return { kind: "error", error: msg };
	}
}
