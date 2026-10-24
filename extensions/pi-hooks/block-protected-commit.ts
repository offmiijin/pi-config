/**
 * Block Protected Commit Hook
 *
 * Bloqueia `git commit` quando o branch atual é `main`, `master` ou
 * `development`. Bloqueio completo e incondicional: não depende de skill
 * ativa e não há exceção via flag (--force, --allow-empty, etc.) ou
 * autorização explícita — o agente deve criar uma branch feature.
 *
 * Ativado via tool_call event (bash).
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROTECTED_BRANCHES = ["main", "master", "development"] as const;

export function isProtectedBranch(branch: string | undefined | null): boolean {
	if (typeof branch !== "string") return false;
	return (PROTECTED_BRANCHES as readonly string[]).includes(branch.trim());
}

function tokenize(part: string): string[] {
	return [...part.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
		(match) => match[1] ?? match[2] ?? match[3],
	);
}

/** Retorna o subcomando do git (ex.: "commit"), pulando opções globais. */
function getGitSubcommand(tokens: string[], gitIndex: number): string | undefined {
	let i = gitIndex + 1;
	while (i < tokens.length) {
		const token = tokens[i];
		const lower = token.toLowerCase();

		// Opções globais com valor separado: -C <path>, -c <kv>, --git-dir <path>, etc.
		if (
			lower === "-c" ||
			lower === "-C" ||
			lower === "--git-dir" ||
			lower === "--work-tree" ||
			lower === "--namespace" ||
			lower === "--super-prefix" ||
			lower === "--config-env"
		) {
			i += 2;
			continue;
		}

		// Formas coladas: --git-dir=<path>, -cfoo=bar
		if (
			/^--?(git-dir|work-tree|namespace|super-prefix|config-env)=/i.test(token) ||
			/^-c.+/i.test(token)
		) {
			i += 1;
			continue;
		}

		// Demais flags globais (--no-pager, -p, --bare, ...).
		if (token.startsWith("-")) {
			i += 1;
			continue;
		}

		return lower;
	}
	return undefined;
}

export function isGitCommitCommand(command: string): boolean {
	if (typeof command !== "string" || !command.trim()) return false;

	// Analisa cada comando simples separadamente; um `git commit` dentro de
	// uma cadeia (&&, ;, |, newline) também deve ser bloqueado.
	const commands = command.split(/[;&|\n]+/);
	return commands.some((part) => {
		const tokens = tokenize(part);
		const gitIndex = tokens.findIndex((token) => /^git$/i.test(token));
		if (gitIndex < 0) return false;
		return getGitSubcommand(tokens, gitIndex) === "commit";
	});
}

/** Extrai o diretório-alvo de `-C <path>` quando presente no comando. */
function extractCwdFromCommand(command: string): string | undefined {
	const commands = command.split(/[;&|\n]+/);
	for (const part of commands) {
		const tokens = tokenize(part);
		const gitIndex = tokens.findIndex((token) => /^git$/i.test(token));
		if (gitIndex < 0) continue;
		for (let i = gitIndex + 1; i < tokens.length; i++) {
			if (tokens[i] === "-C" && tokens[i + 1]) return tokens[i + 1];
		}
	}
	return undefined;
}

export function getCurrentBranch(cwd?: string): string | undefined {
	try {
		const output = execSync("git branch --show-current", {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

export function shouldBlockCommit(command: string, branch: string | undefined | null): boolean {
	return isGitCommitCommand(command) && isProtectedBranch(branch);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !isGitCommitCommand(command)) return;

		const cwd = extractCwdFromCommand(command) ?? process.cwd();
		const branch = getCurrentBranch(cwd);
		if (!isProtectedBranch(branch)) return;

		return {
			block: true,
			reason: `Commit em '${branch}' bloqueado: branches main/master/development são protegidas. Crie uma branch feature (git checkout -b feat/descricao-<numero>) e commite lá.`,
		};
	});
}
