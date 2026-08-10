import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CHANGELOG_PATH = join(homedir(), ".pi", "agent", "CHANGELOG.md");
const CONFIG_FILE = "config.json";

export interface Config { changelogPath: string }

export type ReadResult =
	| { kind: "ok"; content: string }
	| { kind: "missing" }
	| { kind: "error"; error: string };

export async function runChangelogCommand(
	ctx: { hasUI: boolean; ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
	extDir: string,
	pi: ExtensionAPI,
	defaultPath: string = DEFAULT_CHANGELOG_PATH,
): Promise<void> {
	const { config, configError } = readConfig(extDir);
	if (configError) ctx.ui.notify(`⚠️ ${configError} — usando caminho padrão.`, "warning");

	const path = resolveChangelogPath(config?.changelogPath, defaultPath);
	const result = readChangelog(path);

	if (result.kind === "missing") {
		ctx.ui.notify(`❌ CHANGELOG.md não encontrado em ${path}`, "warning");
		return;
	}
	if (result.kind === "error") {
		ctx.ui.notify(`❌ Erro ao ler CHANGELOG.md: ${result.error}`, "error");
		return;
	}
	if (result.content.trim() === "") {
		ctx.ui.notify("📭 CHANGELOG vazio.", "info");
		return;
	}

	// Exibe changelog como entrada no chat com markdown colorido.
	// appendEntry NÃO envia ao LLM — é apenas visual.
	pi.appendEntry("changelog-viewer", { content: result.content });
}

export function getExtensionDir(): string {
	return (import.meta as { dirname?: string }).dirname
		?? dirname(fileURLToPath(import.meta.url));
}

export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function resolveChangelogPath(configured?: string, defaultPath: string = DEFAULT_CHANGELOG_PATH): string {
	if (!configured?.trim()) return defaultPath;
	return resolve(expandTilde(configured.trim()));
}

export function readConfig(extDir: string): { config: Config | null; configError: string | null } {
	const configPath = join(extDir, CONFIG_FILE);
	let raw: string;
	try { raw = readFileSync(configPath, "utf-8") } catch { return { config: null, configError: null } }
	try {
		const p = JSON.parse(raw) as Partial<Config>;
		if (p && typeof p.changelogPath === "string" && p.changelogPath.trim())
			return { config: { changelogPath: p.changelogPath }, configError: null };
		return { config: null, configError: null };
	} catch { return { config: null, configError: "config.json inválido" } }
}

export function readChangelog(path: string): ReadResult {
	try { return { kind: "ok", content: readFileSync(path, "utf-8") } } catch (err) {
		if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "missing" };
		return { kind: "error", error: err instanceof Error ? err.message : String(err) };
	}
}
