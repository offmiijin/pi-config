/**
 * Block Force Push Hook
 *
 * Bloqueia push forçado para main/master quando a skill git-commit estiver ativa.
 * Ativado via tool_call event.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let gitCommitSkillActive = false;

	// Detecta se skill git-commit está carregada
	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions?.skills;
		gitCommitSkillActive =
			skills?.some(
				(s) =>
					typeof s === "string" &&
					(s.includes("git-commit") || s.includes("git_commit") || s.includes("SKILL.md")),
			) ?? false;
	});

	// Bloqueia push forçado para main/master quando skill ativa
	pi.on("tool_call", (event) => {
		if (!gitCommitSkillActive) return;
		if (event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isForcePushToMainOrMaster(command)) return;

		return {
			block: true,
			reason: "Push forçado para main/master bloqueado pela skill git-commit. Crie uma branch feature.",
		};
	});
}

export function isForcePushToMainOrMaster(command: string): boolean {
	// Analisa cada comando simples separadamente; um `git push` dentro de uma
	// cadeia também deve respeitar a política.
	const commands = command.split(/[;&|\n]+/);
	return commands.some((part) => {
		if (!/\bgit\s+push\b/i.test(part)) return false;
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		const pushIndex = tokens.findIndex((token) => /^git$/i.test(token)) + 1;
		if (pushIndex <= 0 || tokens[pushIndex]?.toLowerCase() !== "push") return false;
		const args = tokens.slice(pushIndex + 1);
		const hasForceFlag = args.some((token) =>
			/^(?:--force(?:-with-lease)?(?:=.*)?|-f(?:[a-z]+)?)$/i.test(token),
		);
		if (!hasForceFlag) return false;
		if (args.some((token) => token === "--all" || token === "--mirror")) return true;

		// Aceita refspecs (`+main:main`, `HEAD:refs/heads/main`) e ignora
		// opções antes de procurar o nome da branch protegida.
		return args
			.filter((token) => !token.startsWith("-"))
			.some((token) => token.split(":").some((ref) =>
				["main", "master", "refs/heads/main", "refs/heads/master"].includes(
					ref.replace(/^\+/, "").replace(/^refs\/heads\//, "refs/heads/"),
				),
			));
	});
}
