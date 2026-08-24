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

function isForcePushToMainOrMaster(command: string): boolean {
	if (!/\bgit\s+push\b/i.test(command)) return false;

	const tokens = command.split(/\s+/);
	const hasForceFlag = tokens.some(
		(t) => t === "--force" || t === "--force-with-lease" || t === "-f",
	);
	if (!hasForceFlag) return false;

	const pushesToMainOrMaster = tokens.some(
		(t) => t === "main" || t === "master",
	);

	return pushesToMainOrMaster;
}
