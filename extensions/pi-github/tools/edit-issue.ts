/**
 * Tool: github_edit_issue
 *
 * Edita uma issue existente no GitHub.
 * Para labels e assignees, faz diff: busca estado atual, calcula
 * add/remove, e aplica apenas as diferenças.
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";

interface EditIssueParams {
	number: number;
	repo?: string;
	title?: string;
	body?: string;
	labels?: string[];
	assignees?: string[];
	state?: "open" | "closed";
	milestone?: string;
}

export function editIssueTool(gh: GhApi) {
	return {
		name: "github_edit_issue",
		label: "GitHub: Edit Issue",
		description:
			"Edita uma issue existente no GitHub. " +
			"Parâmetros: number (obrigatório), title, body, labels, " +
			"assignees, state (open/closed), milestone. " +
			"Labels e assignees substituem completamente os atuais.",

		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "Número da issue" }),
			repo: Type.Optional(
				Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$", description: "Repositório (owner/name). Padrão: repositório atual" }),
			),
			title: Type.Optional(Type.String({ description: "Novo título" })),
			body: Type.Optional(Type.String({ description: "Novo body (markdown)" })),
			labels: Type.Optional(
				Type.Array(Type.String(), { description: "Labels (substitui completamente os atuais)" }),
			),
			assignees: Type.Optional(
				Type.Array(Type.String(), { description: "Usuários para atribuir (substitui completamente)" }),
			),
			state: Type.Optional(
				Type.Union(
					[Type.Literal("open"), Type.Literal("closed")],
					{ description: "Novo estado" },
				),
			),
			milestone: Type.Optional(Type.String({ description: "Milestone (número ou título)" })),
		}),

		async execute(
			_toolCallId: string,
			params: EditIssueParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			if (!Number.isInteger(params.number) || params.number < 1) {
				return { content: [{ type: "text" as const, text: "## ❌ Número de issue inválido" }], isError: true };
			}
			const hasChanges = params.title !== undefined || params.body !== undefined ||
				params.labels !== undefined || params.assignees !== undefined ||
				params.state !== undefined || params.milestone !== undefined;
			if (!hasChanges) {
				return { content: [{ type: "text" as const, text: "## ❌ Nenhuma alteração foi informada" }], isError: true };
			}
			try {
				// Se labels ou assignees foram passados, busca estado atual pra fazer diff
				const needsDiff = params.labels !== undefined || params.assignees !== undefined;
				let currentLabels: string[] = [];
				let currentAssignees: string[] = [];

				if (needsDiff) {
					const current = await gh.issueView({
						number: params.number,
						repo: params.repo,
					});
					currentLabels = current.labels.map((l) => l.name);
					currentAssignees = current.assignees.map((a) => a.login);
				}

				// Calcular diff para labels
				let addLabels: string[] | undefined;
				let removeLabels: string[] | undefined;
				if (params.labels !== undefined) {
					addLabels = params.labels.filter((l) => !currentLabels.includes(l));
					removeLabels = currentLabels.filter((l) => !params.labels!.includes(l));
				}

				// Calcular diff para assignees
				let addAssignees: string[] | undefined;
				let removeAssignees: string[] | undefined;
				if (params.assignees !== undefined) {
					addAssignees = params.assignees.filter((a) => !currentAssignees.includes(a));
					removeAssignees = currentAssignees.filter((a) => !params.assignees!.includes(a));
				}

				await gh.issueEdit({
					number: params.number,
					repo: params.repo,
					title: params.title,
					body: params.body,
					addLabels: addLabels?.length ? addLabels : undefined,
					removeLabels: removeLabels?.length ? removeLabels : undefined,
					addAssignees: addAssignees?.length ? addAssignees : undefined,
					removeAssignees: removeAssignees?.length ? removeAssignees : undefined,
					state: params.state,
					milestone: params.milestone,
				});

				// Montar resumo do que foi alterado
				const changes: string[] = [];
				if (params.title !== undefined) changes.push("título");
				if (params.body !== undefined) changes.push("body");
				if (params.labels !== undefined) {
					const added = addLabels?.length ?? 0;
					const removed = removeLabels?.length ?? 0;
					changes.push(`labels (+${added}/-${removed})`);
				}
				if (params.assignees !== undefined) {
					const added = addAssignees?.length ?? 0;
					const removed = removeAssignees?.length ?? 0;
					changes.push(`assignees (+${added}/-${removed})`);
				}
				if (params.state !== undefined) changes.push(`estado → ${params.state}`);
				if (params.milestone !== undefined) changes.push(`milestone → ${params.milestone}`);

				const issueUrl = params.repo
					? `https://github.com/${params.repo}/issues/${params.number}`
					: `https://github.com/offmiijin/pi-config/issues/${params.number}`;

				return {
					content: [
						{
							type: "text" as const,
							text:
								`## ✅ Issue #${params.number} editada\n\n` +
								`**Alterações:** ${changes.join(", ") || "nenhuma"}.\n\n` +
								`[Ver issue](${issueUrl})`,
						},
					],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `## ❌ Erro ao editar issue\n\n\`\`\`\n${msg}\n\`\`\`` }],
					isError: true,
				};
			}
		},
	};
}
