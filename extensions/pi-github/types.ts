/**
 * Tipos e schemas compartilhados da extensão pi-github.
 */

import { Type, type Static } from "typebox";

// ── Schemas dos parâmetros das tools ───────────────────────────────────
// NOTA: gh.ts usa estes tipos para wrapper do gh CLI (title/body simples).
// Os schemas CC (type, scope, quebrando, etc) estão inline nas tools.

const RepoParam = Type.String({
	pattern: "^[^/\\s]+/[^/\\s]+$",
	description: "Repositório no formato owner/name",
});
const PositiveNumber = Type.Integer({ minimum: 1 });
const ResultLimit = Type.Integer({ minimum: 1, maximum: 100, description: "Máximo de resultados" });
const RequiredText = (description: string) => Type.String({ minLength: 1, description });

export const CreatePrParams = Type.Object({
	title: RequiredText("Título do pull request"),
	body: Type.String({ description: "Descrição/corpo do pull request (markdown)" }),
	head: RequiredText("Nome da branch de origem (com as alterações)"),
	base: Type.Optional(RequiredText("Branch de destino (padrão: main)")),
	draft: Type.Optional(Type.Boolean({ description: "Criar como draft PR" })),
});
export type CreatePrParams = Static<typeof CreatePrParams>;

export const CreateIssueParams = Type.Object({
	title: RequiredText("Título da issue"),
	body: Type.String({ description: "Descrição da issue (markdown)" }),
	labels: Type.Optional(Type.Array(Type.String(), { description: "Labels para aplicar" })),
	assignees: Type.Optional(Type.Array(Type.String(), { description: "Usuários para atribuir (login)" })),
});
export type CreateIssueParams = Static<typeof CreateIssueParams>;

export const SearchParams = Type.Object({
	query: RequiredText("Query de busca (sintaxe de busca do GitHub)"),
	repo: Type.Optional(RepoParam),
	state: Type.Optional(
		Type.Union(
			[Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
			{ description: "Filtrar por estado", default: "open" },
		),
	),
});
export type SearchParams = Static<typeof SearchParams>;

export const ListPrsParams = Type.Object({
	state: Type.Optional(
		Type.Union(
			[Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged"), Type.Literal("all")],
			{ description: "Filtrar por estado", default: "open" },
		),
	),
	limit: Type.Optional(ResultLimit),
	author: Type.Optional(Type.String({ description: "Filtrar por autor (login)" })),
});
export type ListPrsParams = Static<typeof ListPrsParams>;

export const ListIssuesParams = Type.Object({
	state: Type.Optional(
		Type.Union(
			[Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
			{ description: "Filtrar por estado", default: "open" },
		),
	),
	limit: Type.Optional(ResultLimit),
	labels: Type.Optional(Type.Array(Type.String(), { description: "Filtrar por labels" })),
});
export type ListIssuesParams = Static<typeof ListIssuesParams>;

export const ViewPrParams = Type.Object({
	number: PositiveNumber,
	repo: Type.Optional(RepoParam),
});
export type ViewPrParams = Static<typeof ViewPrParams>;

export const ViewIssueParams = Type.Object({
	number: PositiveNumber,
	repo: Type.Optional(RepoParam),
});
export type ViewIssueParams = Static<typeof ViewIssueParams>;

// ── Edit ────────────────────────────────────────────────────────────────

export const EditIssueParams = Type.Object({
	number: PositiveNumber,
	repo: Type.Optional(RepoParam),
	title: Type.Optional(Type.String({ description: "Novo título" })),
	body: Type.Optional(Type.String({ description: "Novo body (markdown)" })),
	addLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels para adicionar" })),
	removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels para remover" })),
	addAssignees: Type.Optional(Type.Array(Type.String(), { description: "Usuários para adicionar (login)" })),
	removeAssignees: Type.Optional(Type.Array(Type.String(), { description: "Usuários para remover (login)" })),
	state: Type.Optional(
		Type.Union(
			[Type.Literal("open"), Type.Literal("closed")],
			{ description: "Novo estado (open/closed)" },
		),
	),
	milestone: Type.Optional(Type.String({ description: "Milestone (número ou título)" })),
});
export type EditIssueParams = Static<typeof EditIssueParams>;

export const EditPrParams = Type.Object({
	number: PositiveNumber,
	repo: Type.Optional(RepoParam),
	title: Type.Optional(Type.String({ description: "Novo título" })),
	body: Type.Optional(Type.String({ description: "Novo body (markdown)" })),
	base: Type.Optional(Type.String({ description: "Nova branch de destino" })),
	addLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels para adicionar" })),
	removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels para remover" })),
	addAssignees: Type.Optional(Type.Array(Type.String(), { description: "Usuários para adicionar (login)" })),
	removeAssignees: Type.Optional(Type.Array(Type.String(), { description: "Usuários para remover (login)" })),
	milestone: Type.Optional(Type.String({ description: "Milestone (número ou título)" })),
});
export type EditPrParams = Static<typeof EditPrParams>;

// ── Tipos de resultado retornados pelo gh CLI ─────────────────────────

export interface GhAuthor {
	login: string;
}

export interface GhLabel {
	name: string;
}

export interface GhPrResult {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefName: string;
	baseRefName: string;
	url: string;
	author: GhAuthor;
	createdAt: string;
	updatedAt?: string;
}

export interface GhIssueResult {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	url: string;
	author: GhAuthor;
	createdAt: string;
	labels?: GhLabel[];
}

export interface GhSearchResult {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	url: string;
	repository: { nameWithOwner: string };
	createdAt: string;
}

// ── Info de autenticação ──────────────────────────────────────────────

export interface AuthInfo {
	available: boolean;
	authenticated: boolean;
	user: string;
}

// ── Tipos de detalhes (view) ──────────────────────────────────────────

export interface GhComment {
	author: GhAuthor;
	body: string;
	createdAt: string;
	updatedAt?: string;
}

export interface GhPrDetail {
	number: number;
	title: string;
	body: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefName: string;
	baseRefName: string;
	url: string;
	author: GhAuthor;
	createdAt: string;
	updatedAt?: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	labels: GhLabel[];
	assignees: GhAuthor[];
	comments: GhComment[];
}

export interface GhIssueDetail {
	number: number;
	title: string;
	body: string;
	state: "OPEN" | "CLOSED";
	url: string;
	author: GhAuthor;
	createdAt: string;
	labels: GhLabel[];
	assignees: GhAuthor[];
	comments: GhComment[];
}
