/** Tool de inspeção do repositório Git aninhado das memórias. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

const MAX_OUTPUT_CHARS = 20_000;

type GitParams = {
	action: "status" | "log" | "diff" | "show" | "grep";
	path?: string;
	ref?: string;
	query?: string;
	limit?: number;
};

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return `${output.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: output limitado a ${MAX_OUTPUT_CHARS} caracteres]`;
}

export function registerMemoryGit(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_git",
		label: "Memory Git",
		description:
			"Inspects the nested Git repository of memories (status, log, diff, show and grep). " +
			"Read-only: use Git directly for deliberate restoration. " +
			"NATIVE pi tool — call memory_git directly, NOT via mcp({ tool: 'memory_git' }) or the mcp gateway.",
		promptSnippet: "memory_git: Inspect memory repository history and changes",
		promptGuidelines: [
			"Use memory_git para verificar status, histórico, diff, versões e buscas textuais nas memórias.",
			"memory_git é somente leitura; restauração deliberada deve ser feita manualmente no repositório memories/.",
		],
		parameters: GitSchema,

		async execute(_toolCallId, params: GitParams, _signal, _onUpdate, _ctx) {
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}
			const repo = state.memoryGit;
			if (!repo) {
				return {
					content: [{ type: "text", text: "Memory Git repository unavailable" }],
					details: { error: "git_unavailable" },
				};
			}

			try {
				let output: string;
				switch (params.action) {
					case "status":
						output = repo.status();
						break;
					case "log":
						output = repo.log(params.limit);
						break;
					case "diff":
						output = repo.diff(params.path, params.ref);
						break;
					case "show":
						if (!params.ref || !params.path) {
							return {
								content: [{ type: "text", text: "show requer ref e path" }],
								details: { error: "missing_show_arguments" },
							};
						}
						output = repo.show(params.ref, params.path);
						break;
					case "grep":
						if (!params.query) {
							return {
								content: [{ type: "text", text: "grep requer query" }],
								details: { error: "missing_grep_query" },
							};
						}
						output = repo.grep(params.query, params.ref);
						break;
				}

				const text = truncateOutput(output) || "(nenhuma alteração ou resultado)";
				return {
					content: [{ type: "text", text }],
					details: { action: params.action, output: text },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Memory Git error: ${(err as Error).message}` }],
					details: { error: "git_command_failed", action: params.action },
				};
			}
		},
	});
}
