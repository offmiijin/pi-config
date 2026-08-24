/**
 * Wrapper thin sobre gh CLI usando pi.exec().
 *
 * Cada método monta os argumentos do gh, executa via pi.exec(),
 * e parseia o JSON de saída quando aplicável.
 *
 * Uso:
 *   const gh = createGh(pi.exec.bind(pi));
 *   const pr = await gh.prCreate({ title: "...", body: "...", head: "feat/x", base: "main" });
 */

import type {
	CreatePrParams,
	CreateIssueParams,
	EditIssueParams,
	EditPrParams,
	ListPrsParams,
	ListIssuesParams,
	SearchParams,
	ViewPrParams,
	ViewIssueParams,
	GhPrResult,
	GhIssueResult,
	GhSearchResult,
	GhPrDetail,
	GhIssueDetail,
} from "./types";

// Tipos internos

type ExecFn = (
	command: string,
	args: string[],
	options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

// Helper: executa gh e retorna stdout parseado ou texto puro

async function execGh<T>(
	exec: ExecFn,
	args: string[],
	parseJson: true,
	timeout?: number,
): Promise<T>;
async function execGh<T>(
	exec: ExecFn,
	args: string[],
	parseJson?: false,
	timeout?: number,
): Promise<string>;
async function execGh<T>(
	exec: ExecFn,
	args: string[],
	parseJson = false,
	timeout = 30_000,
): Promise<T | string> {
	const result = await exec("gh", args, { timeout });

	if (result.code !== 0) {
		const msg = result.stderr.trim() || result.stdout.trim();
		// Tenta extrair mensagem útil do stderr do gh
		const cleanMsg = msg.replace(/^gh: /, "");
		throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${cleanMsg}`);
	}

	if (parseJson) return JSON.parse(result.stdout) as T;
	return result.stdout.trim();
}

// Factory

export function createGh(exec: ExecFn) {
	return {
		// ── PRs ───────────────────────────────────────────────────────
		async prCreate(opts: CreatePrParams): Promise<{ url: string; number: number }> {
			const args = [
				"pr", "create",
				"--title", opts.title,
				"--body", opts.body,
				"--head", opts.head,
				"--base", opts.base ?? "main",
			];
			if (opts.draft) args.push("--draft");

			const url = await execGh<string>(exec, args);
			const number = parseInt(url.match(/\/(\d+)$/)?.[1] ?? "0", 10);
			return { url, number };
		},

		async prList(opts: ListPrsParams = {}): Promise<GhPrResult[]> {
			const args = [
				"pr", "list",
				"--json", "number,title,state,headRefName,baseRefName,url,author,createdAt,updatedAt",
			];
			if (opts.state && opts.state !== "all") args.push("--state", opts.state);
			if (opts.limit) args.push("--limit", String(opts.limit));
			if (opts.author) args.push("--author", opts.author);

			return execGh<GhPrResult[]>(exec, args, true);
		},

		// ── Issues ────────────────────────────────────────────────────
		async issueCreate(opts: CreateIssueParams): Promise<{ url: string; number: number }> {
			const args = [
				"issue", "create",
				"--title", opts.title,
				"--body", opts.body,
			];
			if (opts.labels?.length) args.push("--label", opts.labels.join(","));
			if (opts.assignees?.length) args.push("--assignee", opts.assignees.join(","));

			const url = await execGh<string>(exec, args);
			const number = parseInt(url.match(/\/(\d+)$/)?.[1] ?? "0", 10);
			return { url, number };
		},

		async issueList(opts: ListIssuesParams = {}): Promise<GhIssueResult[]> {
			const args = [
				"issue", "list",
				"--json", "number,title,state,labels,url,author,createdAt",
			];
			if (opts.state && opts.state !== "all") args.push("--state", opts.state);
			if (opts.limit) args.push("--limit", String(opts.limit));
			if (opts.labels?.length) args.push("--label", opts.labels.join(","));

			return execGh<GhIssueResult[]>(exec, args, true);
		},

		// ── Search ────────────────────────────────────────────────────
		async search(opts: SearchParams): Promise<GhSearchResult[]> {
			let q = opts.query;
			if (opts.repo) q += ` repo:${opts.repo}`;
			if (opts.state && opts.state !== "all") q += ` state:${opts.state}`;

			const args = [
				"search", "issues", q,
				"--json", "number,title,state,url,repository,createdAt",
			];

			return execGh<GhSearchResult[]>(exec, args, true);
		},

		// ── View PR ───────────────────────────────────────────────────
		async prView(opts: ViewPrParams): Promise<GhPrDetail> {
			const args = [
				"pr", "view", String(opts.number),
				"--json", "number,title,body,state,headRefName,baseRefName,url,author,createdAt,updatedAt,mergeable,labels,assignees,comments",
			];
			if (opts.repo) args.push("--repo", opts.repo);
			return execGh<GhPrDetail>(exec, args, true);
		},

		// ── View Issue ────────────────────────────────────────────────
		async issueView(opts: ViewIssueParams): Promise<GhIssueDetail> {
			const args = [
				"issue", "view", String(opts.number),
				"--json", "number,title,body,state,url,author,createdAt,labels,assignees,comments",
			];
			if (opts.repo) args.push("--repo", opts.repo);
			return execGh<GhIssueDetail>(exec, args, true);
		},

		// ── Edit Issue ───────────────────────────────────────────────
		async issueEdit(opts: EditIssueParams): Promise<string> {
			const args = ["issue", "edit", String(opts.number)];
			if (opts.repo) args.push("--repo", opts.repo);
			if (opts.title !== undefined) args.push("--title", opts.title);
			if (opts.body !== undefined) args.push("--body", opts.body);
			if (opts.addLabels?.length) args.push("--add-label", opts.addLabels.join(","));
			if (opts.removeLabels?.length) args.push("--remove-label", opts.removeLabels.join(","));
			if (opts.addAssignees?.length) args.push("--add-assignee", opts.addAssignees.join(","));
			if (opts.removeAssignees?.length) args.push("--remove-assignee", opts.removeAssignees.join(","));
			if (opts.state) args.push("--state", opts.state);
			if (opts.milestone) args.push("--milestone", opts.milestone);

			return execGh<string>(exec, args);
		},

		// ── Edit PR ──────────────────────────────────────────────────
		async prEdit(opts: EditPrParams): Promise<string> {
			const args = ["pr", "edit", String(opts.number)];
			if (opts.repo) args.push("--repo", opts.repo);
			if (opts.title !== undefined) args.push("--title", opts.title);
			if (opts.body !== undefined) args.push("--body", opts.body);
			if (opts.base) args.push("--base", opts.base);
			if (opts.addLabels?.length) args.push("--add-label", opts.addLabels.join(","));
			if (opts.removeLabels?.length) args.push("--remove-label", opts.removeLabels.join(","));
			if (opts.addAssignees?.length) args.push("--add-assignee", opts.addAssignees.join(","));
			if (opts.removeAssignees?.length) args.push("--remove-assignee", opts.removeAssignees.join(","));
			if (opts.milestone) args.push("--milestone", opts.milestone);

			return execGh<string>(exec, args);
		},

		// ── Auth ──────────────────────────────────────────────────────
		async getUser(): Promise<{ user: string }> {
			const out = await execGh<string>(exec, ["auth", "status"]);
			const match = out.match(/as\s+(\S+)/);
			return { user: match?.[1] ?? "unknown" };
		},
	};
}

export type GhApi = ReturnType<typeof createGh>;
