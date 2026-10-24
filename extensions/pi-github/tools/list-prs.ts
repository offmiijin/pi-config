/**
 * Tool: github_list_prs
 *
 * Lista pull requests do repositório atual.
 * LLM usa para consultar PRs abertas antes de agir.
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";

export function listPrsTool(gh: GhApi) {
	return {
		name: "github_list_prs",
		label: "GitHub: List PRs",
		description:
			"Lista pull requests do repositório atual. Use para consultar PRs existentes, " +
			"verificar estado, ou encontrar PRs de um autor específico. " +
			"Retorna número, título, estado, branches, autor e data.",

		parameters: Type.Object({
			state: Type.Optional(
				Type.Union(
					[Type.Literal("open"), Type.Literal("closed"), Type.Literal("all"), Type.Literal("merged")],
					{ description: "Filtrar por estado", default: "open" },
				),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: "Máximo de resultados", default: 10 }),
			),
			author: Type.Optional(
				Type.String({ minLength: 1, description: "Filtrar por autor (login do GitHub)" }),
			),
		}),

		async execute(
			_toolCallId: string,
			params: { state?: string; limit?: number; author?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			try {
				const prs = await gh.prList({
					state: params.state,
					limit: params.limit ?? 10,
					author: params.author,
				});

				if (prs.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "📭 Nenhum pull request encontrado.",
							},
						],
					};
				}

				const header = params.author
					? `PRs de **@${params.author}** (${params.state ?? "open"})`
					: `Pull Requests (${params.state ?? "open"})`;

				const lines = [`## ${header}`, ``, `${prs.length} encontrado${prs.length > 1 ? "s" : ""}`, ``];

				for (const pr of prs) {
					const icon =
						pr.state === "MERGED" ? "✅" : pr.state === "OPEN" ? "🟢" : "🔴";
					const stateLabel =
						pr.state === "MERGED"
							? "merged"
							: pr.state === "OPEN"
								? "open"
								: "closed";
					lines.push(
						`${icon} **#${pr.number}** — [${pr.title}](${pr.url})`,
						`   \`${pr.headRefName}\` → \`${pr.baseRefName}\` · ${stateLabel} · @${pr.author.login}`,
						`   ${new Date(pr.createdAt).toLocaleDateString("pt-BR")}`,
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
							text: `## ❌ Erro ao listar PRs\n\n\`\`\`\n${msg}\n\`\`\``,
						},
					],
					isError: true,
				};
			}
		},
	};
}
