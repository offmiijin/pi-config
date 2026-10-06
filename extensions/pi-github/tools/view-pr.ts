/**
 * Tool: github_pr_view
 *
 * Exibe detalhes completos de um pull request: body, labels, assignees,
 * mergeability, e comentários recentes.
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";

export function viewPrTool(gh: GhApi) {
	return {
		name: "github_pr_view",
		label: "GitHub: View PR Details",
		description:
			"Exibe detalhes completos de um pull request (body, status, mergeabilidade, " +
			"labels, assignees, comentários). Use quando precisar do corpo ou informações " +
			"detalhadas de um PR específico.",

		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "Número do pull request" }),
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
				const pr = await gh.prView({
					number: params.number,
					repo: params.repo,
				});

				const lines: string[] = [
					`## ${pr.state === "OPEN" ? "🟢" : pr.state === "MERGED" ? "✅" : "🔴"} #${pr.number} — ${pr.title}`,
					"",
					`**Estado:** ${pr.state.toLowerCase()}` +
						` · **Mergeável:** ${pr.mergeable === "MERGEABLE" ? "✅ sim" : pr.mergeable === "CONFLICTING" ? "❌ conflitos" : "❓ desconhecido"}`,
					`**Branch:** \`${pr.headRefName}\` → \`${pr.baseRefName}\``,
					`**Autor:** @${pr.author.login} · ${new Date(pr.createdAt).toLocaleDateString("pt-BR")}`,
				];

				if (pr.labels.length > 0) {
					lines.push(`**Labels:** ${pr.labels.map((l) => l.name).join(", ")}`);
				}
				if (pr.assignees.length > 0) {
					lines.push(
						`**Assignees:** ${pr.assignees.map((a) => `@${a.login}`).join(", ")}`,
					);
				}

				lines.push("", `**URL:** ${pr.url}`);

				// Body
				if (pr.body) {
					lines.push("", "---", "", pr.body);
				} else {
					lines.push("", "*Sem descrição*");
				}

				// Comentários (últimos 5)
				if (pr.comments.length > 0) {
					const recent = pr.comments.slice(-5);
					lines.push("", "---", `**Comentários** (${pr.comments.length} total, exibindo ${recent.length}):`, "");
					for (const c of recent) {
						lines.push(`**@${c.author.login}** · ${new Date(c.createdAt).toLocaleDateString("pt-BR")}:`);
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
							text: `## ❌ Erro ao buscar PR #${params.number}\n\n\`\`\`\n${msg}\n\`\`\``,
						},
					],
					isError: true,
				};
			}
		},
	};
}
