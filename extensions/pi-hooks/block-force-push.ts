/**
 * Block Force Push Hook
 *
 * Bloqueia push forçado para main/master quando a skill git-commit estiver ativa.
 * Ativado via tool_call event.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let gitCommitSkillActive = false;

	// Detecta somente a skill git-commit, não qualquer arquivo chamado SKILL.md.
	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions?.skills;
		gitCommitSkillActive =
			skills?.some((skill) => typeof skill === "string" && isGitCommitSkill(skill)) ?? false;
	});

	// Bloqueia push forçado para main/master quando a skill ativa.
	pi.on("tool_call", (event) => {
		if (!gitCommitSkillActive || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isForcePushToMainOrMaster(command)) return;

		return {
			block: true,
			reason: "Push forçado para main/master bloqueado pela skill git-commit. Crie uma branch feature.",
		};
	});
}

export function isGitCommitSkill(skill: string): boolean {
	const normalized = skill.trim().toLowerCase().replaceAll("\\", "/");
	return /(?:^|\/)git[-_]commit(?:\/|$)/.test(normalized);
}

function normalizeRef(ref: string): string {
	return ref
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/^\+/, "")
		.replace(/^refs\/heads\//, "");
}

function tokenize(part: string): string[] {
	return [...part.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

export function isForcePushToMainOrMaster(command: string): boolean {
	if (typeof command !== "string" || !command.trim()) return false;

	// Analisa cada comando simples separadamente; um `git push` dentro de uma
	// cadeia também deve respeitar a política.
	const commands = command.split(/[;&|\n]+/);
	return commands.some((part) => {
		const tokens = tokenize(part);
		const gitIndex = tokens.findIndex((token) => /^git$/i.test(token));
		if (gitIndex < 0 || tokens[gitIndex + 1]?.toLowerCase() !== "push") return false;

		const args = tokens.slice(gitIndex + 2);
		const hasForceFlag = args.some((token) =>
			/^(?:--force(?:-with-lease)?(?:=.*)?|-f(?:[a-z]+)?)$/i.test(token),
		);
		if (!hasForceFlag) return false;
		if (args.some((token) => token === "--all" || token === "--mirror")) return true;

		const positional = args.filter((token) => !token.startsWith("-"));
		if (positional.length < 2) return false;
		const refspecs = positional.slice(1);
		return refspecs.some((refspec) => {
			const [, destination = refspec] = refspec.split(":", 2);
			return ["main", "master"].includes(normalizeRef(destination));
		});
	});
}
