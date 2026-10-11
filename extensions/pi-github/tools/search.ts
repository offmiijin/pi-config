/**
 * Tool: github_search
 *
 * Busca issues e PRs no GitHub via sintaxe de busca nativa.
 * LLM usa para encontrar issues/PRs existentes antes de duplicar.
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";

export function searchTool(gh: GhApi) {
	return {
		name: "github_search",
		label: "GitHub: Search Issues/PRs",
		description:
			"Busca issues e pull requests no GitHub usando a sintaxe de busca nativa. " +
			"Use antes de criar uma issue/PR para verificar se já existe. " +
			"Retorna número, título, estado, URL, repositório e data de criação. " +
			"Exemplos de query: \"bug login\", \"feat: auth\" repo:owner/name is:issue is:open",

		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				description:
					"Query de busca (sintaxe GitHub). Ex: \"bug login\" repo:owner/name is:open",
			}),
			repo: Type.Optional(
				Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$", description: "Limitar a um repositório (formato: owner/name)" }),
			),
			state: Type.Optional(
				Type.Union(
					[Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
					{ description: "Filtrar por estado", default: "open" },
				),
			),
		}),

		async execute(
			_toolCallId: string,
			params: { query: string; repo?: string; state?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			try {
				const results = await gh.search({
					query: params.query,
					repo: params.repo,
					state: params.state,
				});

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `🔍 Nenhum resultado para "${params.query}"`,
							},
						],
					};
				}

				const lines = [
					`## 🔍 Resultados da busca: "${params.query}"`,
					"",
					`(${results.length} encontrado${results.length > 1 ? "s" : ""})`,
					"",
				];

				for (const r of results) {
					const icon = r.state === "OPEN" ? "🟢" : "🔴";
					lines.push(
						`${icon} **#${r.number}** — [${r.title}](${r.url})`,
						`   \`${r.repository.nameWithOwner}\` · ${r.state}`,
						`   Criado: ${new Date(r.createdAt).toLocaleDateString("pt-BR")}`,
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
							text: `## ❌ Erro na busca\n\n\`\`\`\n${msg}\n\`\`\``,
						},
					],
					isError: true,
				};
			}
		},
	};
}
