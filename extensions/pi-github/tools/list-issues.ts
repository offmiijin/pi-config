/**
 * Tool: github_list_issues
 *
 * Lista issues do repositório atual.
 * LLM usa para consultar issues abertas, filtrar por label, etc.
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";

export function listIssuesTool(gh: GhApi) {
	return {
		name: "github_list_issues",
		label: "GitHub: List Issues",
		description:
			"Lista issues do repositório atual. Use para consultar issues existentes, " +
			"filtrar por label ou estado. Retorna número, título, estado, labels, autor e data.",

		parameters: Type.Object({
			state: Type.Optional(
				Type.Union(
					[Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
					{ description: "Filtrar por estado", default: "open" },
				),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: "Máximo de resultados", default: 10 }),
			),
			labels: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), { description: "Filtrar por labels" }),
			),
		}),

		async execute(
			_toolCallId: string,
			params: { state?: string; limit?: number; labels?: string[] },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			try {
				const issues = await gh.issueList({
					state: params.state,
					limit: params.limit ?? 10,
					labels: params.labels,
				});

				if (issues.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "📭 Nenhuma issue encontrada.",
							},
						],
					};
				}

				const labelFilter =
					params.labels?.length ? ` com label "${params.labels.join(", ")}"` : "";
				const lines = [
					`## Issues (${params.state ?? "open"}${labelFilter})`,
					"",
					`${issues.length} encontrada${issues.length > 1 ? "s" : ""}`,
					"",
				];

				for (const issue of issues) {
					const icon = issue.state === "OPEN" ? "🟢" : "🔴";
					const labelStr = issue.labels?.length
						? ` [${issue.labels.map((l) => l.name).join(", ")}]`
						: "";
					lines.push(
						`${icon} **#${issue.number}** — [${issue.title}](${issue.url})${labelStr}`,
						`   @${issue.author.login} · ${new Date(issue.createdAt).toLocaleDateString("pt-BR")}`,
						"",
					);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `## ❌ Erro ao listar issues\n\n\`\`\`\n${msg}\n\`\`\``,
						},
					],
					isError: true,
				};
			}
		},
	};
}
