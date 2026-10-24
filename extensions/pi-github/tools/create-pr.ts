/**
 * Tool: github_create_pr
 *
 * Cria pull request via gh CLI com formato Conventional Commits.
 * Valida o título antes de criar.
 *
 * Formato gerado:
 *   <type>(<scope>)[!]: <title> [#<taskNumber>]
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";
import { buildTitle, validateTitle, type CommitType, VALID_TYPES } from "./validate";

/** Parâmetro tipado (TypeBox gera Static equivalente, mas garantimos o tipo aqui) */
interface CreatePrParams {
	type: CommitType;
	scope: string;
	title: string;
	breaking?: boolean;
	taskNumber?: string | number;
	body: string;
	head: string;
	base?: string;
	draft?: boolean;
}

export function createPrTool(gh: GhApi) {
	return {
		name: "github_create_pr",
		label: "GitHub: Create PR",
		description:
			"Cria um pull request no GitHub seguindo Conventional Commits. " +
			"O título é montado automaticamente como type(scope)[!]: descrição [#numero]. " +
			"Parâmetros: type, scope, title (descrição curta), body (markdown), " +
			"head (branch origem), base, draft, breaking, taskNumber.",

		parameters: Type.Object({
			type: Type.Union(
				[...VALID_TYPES].map((t) => Type.Literal(t)),
				{ description: "Tipo da mudança (ex: feat, fix, refactor)" },
			),
			scope: Type.String({ minLength: 1, description: "Escopo/módulo da alteração (ex: auth, api/orders, docker)" }),
			title: Type.String({ minLength: 1, description: "Descrição curta, sem type/scope/numero" }),
			breaking: Type.Optional(
				Type.Boolean({ description: "Se true, adiciona '!' e deve incluir BREAKING CHANGE: no body", default: false }),
			),
			taskNumber: Type.Optional(
				Type.Union([Type.String(), Type.Number()], { description: "Nº da tarefa (opcional, vai no título como #numero)" }),
			),
			body: Type.String({ description: "Descrição/corpo (markdown). Se breaking=true, incluir BREAKING CHANGE: <desc>" }),
			head: Type.String({ minLength: 1, description: "Branch de origem" }),
			base: Type.Optional(Type.String({ minLength: 1, description: "Branch de destino", default: "main" })),
			draft: Type.Optional(Type.Boolean({ description: "Criar como draft PR", default: false })),
		}),

		async execute(
			_toolCallId: string,
			params: CreatePrParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			try {
				// 1. Construir título
				const fullTitle = buildTitle({
					type: params.type,
					scope: params.scope,
					title: params.title,
					breaking: params.breaking,
					taskNumber: params.taskNumber,
				});

				// 2. Validar título
				const validation = validateTitle(fullTitle);
				if (!validation.valid) {
					return {
						content: [{ type: "text" as const, text: `## ❌ Título inválido\n\n${validation.error}` }],
						isError: true,
					};
				}

				// 3. Criar PR
				const result = await gh.prCreate({
					title: fullTitle,
					body: params.body,
					head: params.head,
					base: params.base ?? "main",
					draft: params.draft,
				});

				return {
					content: [
						{
							type: "text" as const,
							text:
								`## ✅ PR criado\n\n` +
								`**#${result.number}** — [${fullTitle}](${result.url})\n\n` +
								`Branch: \`${params.head}\` → \`${params.base ?? "main"}\`\n` +
								`${params.draft ? "*(draft)*" : ""}`,
						},
					],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `## ❌ Erro ao criar PR\n\n\`\`\`\n${msg}\n\`\`\`` }],
					isError: true,
				};
			}
		},
	};
}
