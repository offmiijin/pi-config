/**
 * Tool: github_issue_view
 *
 * Exibe detalhes completos de uma issue: body, labels, assignees,
 * e comentários recentes.
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";

export function viewIssueTool(gh: GhApi) {
	return {
		name: "github_issue_view",
		label: "GitHub: View Issue Details",
		description:
			"Exibe detalhes completos de uma issue (body, estado, labels, assignees, " +
			"comentários). Use quando precisar do corpo ou informações detalhadas " +
			"de uma issue específica.",

		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "Número da issue" }),
			repo: Type.Optional(
				Type.String({
					pattern: "^[^/\\s]+/[^/\\s]+$",
					description: "Repositório (owner/name). Padrão: repositório atual",
				}),
			),
		}),

		async execute(
			_toolCallId: string,
			params: { number: number; repo?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			try {
				const issue = await gh.issueView({
					number: params.number,
					repo: params.repo,
				});

				const lines: string[] = [
					`## ${issue.state === "OPEN" ? "🟢" : "🔴"} #${issue.number} — ${issue.title}`,
					"",
					`**Estado:** ${issue.state.toLowerCase()}`,
					`**Autor:** @${issue.author.login} · ${new Date(issue.createdAt).toLocaleDateString("pt-BR")}`,
				];

				if (issue.labels.length > 0) {
					lines.push(`**Labels:** ${issue.labels.map((l) => l.name).join(", ")}`);
				}
				if (issue.assignees.length > 0) {
					lines.push(
						`**Assignees:** ${issue.assignees.map((a) => `@${a.login}`).join(", ")}`,
					);
				}

				lines.push("", `**URL:** ${issue.url}`);

				// Body
				if (issue.body) {
					lines.push("", "---", "", issue.body);
				} else {
					lines.push("", "*Sem descrição*");
				}

				// Comentários (últimos 5)
				if (issue.comments.length > 0) {
					const recent = issue.comments.slice(-5);
					lines.push(
						"",
						"---",
						`**Comentários** (${issue.comments.length} total, exibindo ${recent.length}):`,
						"",
					);
					for (const c of recent) {
						lines.push(
							`**@${c.author.login}** · ${new Date(c.createdAt).toLocaleDateString("pt-BR")}:`,
						);
						lines.push(c.body, "");
					}
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `## ❌ Erro ao buscar issue #${params.number}\n\n\`\`\`\n${msg}\n\`\`\``,
						},
					],
					isError: true,
				};
			}
		},
	};
}
