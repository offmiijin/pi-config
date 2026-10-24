/**
 * Tool: github_create_issue
 *
 * Cria issue no GitHub com formato Conventional Commits.
 * Valida o título antes de criar.
 *
 * Formato gerado:
 *   <type>(<scope>)[!]: <title> [#<taskNumber>]
 */

import { Type } from "typebox";
import type { GhApi } from "../gh";
import { buildTitle, validateTitle, type CommitType, VALID_TYPES } from "./validate";

interface CreateIssueParams {
	type: CommitType;
	scope: string;
	title: string;
	breaking?: boolean;
	taskNumber?: string | number;
	body: string;
	labels: string[];
	assignees?: string[];
}

export function createIssueTool(gh: GhApi) {
	return {
		name: "github_create_issue",
		label: "GitHub: Create Issue",
		description:
			"Cria uma issue no GitHub seguindo Conventional Commits. " +
			"O título é montado como type(scope)[!]: descrição [#numero]. " +
			"Use para reportar bugs, sugerir features, ou registrar tarefas. " +
			"Parâmetros: type, scope, title (descrição curta), body (markdown), " +
			"labels, assignees, breaking, taskNumber.",

		parameters: Type.Object({
			type: Type.Union(
				[...VALID_TYPES].map((t) => Type.Literal(t)),
				{ description: "Tipo da mudança (ex: feat, fix, refactor)" },
			),
			scope: Type.String({ minLength: 1, description: "Escopo/módulo (ex: auth, api/orders, docs)" }),
			title: Type.String({ minLength: 1, description: "Descrição curta, sem type/scope/numero" }),
			breaking: Type.Optional(
				Type.Boolean({ description: "Se true, adiciona '!' e deve incluir BREAKING CHANGE: no body", default: false }),
			),
			taskNumber: Type.Optional(
				Type.Union([Type.String(), Type.Number()], { description: "Nº da tarefa (opcional, vai no título como #numero)" }),
			),
			body: Type.String({ description: "Descrição (markdown). Se breaking=true, incluir BREAKING CHANGE: <desc>" }),
			labels: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Labels para aplicar (obrigatório — ex: bug, enhancement, documentation, question)" }),
			assignees: Type.Optional(Type.Array(Type.String(), { description: "Usuários para atribuir (login)" })),
		}),

		async execute(
			_toolCallId: string,
			params: CreateIssueParams,
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

				// 3. Criar issue
				const result = await gh.issueCreate({
					title: fullTitle,
					body: params.body,
					labels: params.labels,
					assignees: params.assignees,
				});

				const parts: string[] = [
					`## ✅ Issue criada\n`,
					`**#${result.number}** — [${fullTitle}](${result.url})`,
				];
				if (params.labels?.length) {
					parts.push(`\nLabels: ${params.labels.join(", ")}`);
				}
				if (params.assignees?.length) {
					parts.push(`Assignees: ${params.assignees.join(", ")}`);
				}

				return { content: [{ type: "text" as const, text: parts.join("\n") }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `## ❌ Erro ao criar issue\n\n\`\`\`\n${msg}\n\`\`\`` }],
					isError: true,
				};
			}
		},
	};
}
