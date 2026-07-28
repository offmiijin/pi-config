/**
 * Tests for gh.ts
 *
 * Covers: createGh factory and all its methods
 */

import { describe, it, expect, vi } from "vitest";
import { createGh } from "../gh";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExec(
	overrides?: Partial<{
		stdout: string;
		stderr: string;
		code: number;
	}>,
) {
	return vi.fn().mockResolvedValue({
		stdout: overrides?.stdout ?? "",
		stderr: overrides?.stderr ?? "",
		code: overrides?.code ?? 0,
		killed: false,
	});
}

function makeGhResult(data: unknown): string {
	return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// createGh
// ---------------------------------------------------------------------------
describe("createGh", () => {
	// ── prCreate ─────────────────────────────────────────────────────
	describe("prCreate", () => {
		it("creates a PR and returns url and number", async () => {
			const exec = makeExec({ stdout: "https://github.com/owner/repo/pull/42" });
			const gh = createGh(exec);

			const result = await gh.prCreate({
				title: "feat(auth): Add login",
				body: "## Description\n\nLogin flow",
				head: "feat/auth",
				base: "main",
			});

			expect(result).toEqual({ url: "https://github.com/owner/repo/pull/42", number: 42 });
			expect(exec).toHaveBeenCalledWith("gh", [
				"pr", "create",
				"--title", "feat(auth): Add login",
				"--body", "## Description\n\nLogin flow",
				"--head", "feat/auth",
				"--base", "main",
			], { timeout: 30000 });
		});

		it("accepts draft flag", async () => {
			const exec = makeExec({ stdout: "https://github.com/owner/repo/pull/7" });
			const gh = createGh(exec);

			await gh.prCreate({
				title: "feat: WIP",
				body: "Draft",
				head: "feat/wip",
				draft: true,
			});

			expect(exec.mock.calls[0][1]).toContain("--draft");
		});

		it("defaults base to main", async () => {
			const exec = makeExec({ stdout: "https://github.com/owner/repo/pull/1" });
			const gh = createGh(exec);

			await gh.prCreate({
				title: "feat: test",
				body: "body",
				head: "feat/test",
			});

			const args = exec.mock.calls[0][1];
			expect(args).toContain("--base");
			expect(args[args.indexOf("--base") + 1]).toBe("main");
		});

		it("throws on non-zero exit code", async () => {
			const exec = makeExec({ code: 1, stderr: "gh: XPC error: connection invalid" });
			const gh = createGh(exec);

			await expect(
				gh.prCreate({ title: "fail", body: "", head: "fail" }),
			).rejects.toThrow("gh pr create: XPC error: connection invalid");
		});
	});

	// ── prList ───────────────────────────────────────────────────────
	describe("prList", () => {
		it("lists PRs with default options", async () => {
			const data = [
				{ number: 1, title: "PR 1", state: "OPEN", headRefName: "feat/a", baseRefName: "main", url: "https://github.com/owner/repo/pull/1", author: { login: "user1" }, createdAt: "2024-01-01T00:00:00Z" },
			];
			const exec = makeExec({ stdout: makeGhResult(data) });
			const gh = createGh(exec);

			const result = await gh.prList({});
			expect(result).toEqual(data);
			expect(exec.mock.calls[0][1]).toEqual([
				"pr", "list",
				"--json", "number,title,state,headRefName,baseRefName,url,author,createdAt,updatedAt",
			]);
		});

		it("filters by state", async () => {
			const exec = makeExec({ stdout: "[]" });
			const gh = createGh(exec);

			await gh.prList({ state: "closed" });
			expect(exec.mock.calls[0][1]).toContain("--state");
			expect(exec.mock.calls[0][1]).toContain("closed");
		});

		it("skips --state when state is 'all'", async () => {
			const exec = makeExec({ stdout: "[]" });
			const gh = createGh(exec);

			await gh.prList({ state: "all" });
			expect(exec.mock.calls[0][1]).not.toContain("--state");
		});

		it("filters by author", async () => {
			const exec = makeExec({ stdout: "[]" });
			const gh = createGh(exec);

			await gh.prList({ author: "miyake" });
			expect(exec.mock.calls[0][1]).toContain("--author");
			expect(exec.mock.calls[0][1]).toContain("miyake");
		});
	});

	// ── issueCreate ──────────────────────────────────────────────────
	describe("issueCreate", () => {
		it("creates issue with labels and assignees", async () => {
			const exec = makeExec({ stdout: "https://github.com/owner/repo/issues/10" });
			const gh = createGh(exec);

			const result = await gh.issueCreate({
				title: "fix: Bug report",
				body: "Details",
				labels: ["bug", "urgent"],
				assignees: ["user1"],
			});

			expect(result).toEqual({ url: "https://github.com/owner/repo/issues/10", number: 10 });
			expect(exec.mock.calls[0][1]).toContain("--label");
			expect(exec.mock.calls[0][1]).toContain("bug,urgent");
			expect(exec.mock.calls[0][1]).toContain("--assignee");
			expect(exec.mock.calls[0][1]).toContain("user1");
		});
	});

	// ── issueList ────────────────────────────────────────────────────
	describe("issueList", () => {
		it("filters by label", async () => {
			const exec = makeExec({ stdout: "[]" });
			const gh = createGh(exec);

			await gh.issueList({ labels: ["bug"] });
			expect(exec.mock.calls[0][1]).toContain("--label");
			expect(exec.mock.calls[0][1]).toContain("bug");
		});
	});

	// ── search ───────────────────────────────────────────────────────
	describe("search", () => {
		it("builds query with repo filter", async () => {
			const exec = makeExec({ stdout: "[]" });
			const gh = createGh(exec);

			await gh.search({ query: "bug login", repo: "owner/name" });
			const args = exec.mock.calls[0][1];
			expect(args[2]).toContain("bug login repo:owner/name");
		});

		it("appends state filter when not 'all'", async () => {
			const exec = makeExec({ stdout: "[]" });
			const gh = createGh(exec);

			await gh.search({ query: "test", state: "closed" });
			const args = exec.mock.calls[0][1];
			expect(args[2]).toContain("test state:closed");
		});
	});

	// ── prView / issueView ───────────────────────────────────────────
	describe("prView", () => {
		it("views a PR by number", async () => {
			const data = {
				number: 5, title: "PR 5", body: "body", state: "OPEN",
				headRefName: "feat/x", baseRefName: "main",
				url: "https://github.com/owner/repo/pull/5",
				author: { login: "user1" }, createdAt: "2024-01-01T00:00:00Z",
				mergeable: "MERGEABLE" as const,
				labels: [{ name: "bug" }], assignees: [{ login: "user1" }],
				comments: [{ author: { login: "user2" }, body: "LGTM", createdAt: "2024-01-02T00:00:00Z" }],
			};
			const exec = makeExec({ stdout: makeGhResult(data) });
			const gh = createGh(exec);

			const result = await gh.prView({ number: 5 });
			expect(result).toEqual(data);
			expect(exec.mock.calls[0][1]).toContain("5");
		});

		it("passes --repo when provided", async () => {
			const exec = makeExec({ stdout: "{}" });
			const gh = createGh(exec);

			await gh.prView({ number: 1, repo: "owner/name" });
			expect(exec.mock.calls[0][1]).toContain("--repo");
			expect(exec.mock.calls[0][1]).toContain("owner/name");
		});
	});

	describe("issueView", () => {
		it("views an issue by number", async () => {
			const data = {
				number: 3, title: "Issue 3", body: "body", state: "OPEN",
				url: "https://github.com/owner/repo/issues/3",
				author: { login: "user1" }, createdAt: "2024-01-01T00:00:00Z",
				labels: [{ name: "enhancement" }], assignees: [],
				comments: [],
			};
			const exec = makeExec({ stdout: makeGhResult(data) });
			const gh = createGh(exec);

			const result = await gh.issueView({ number: 3 });
			expect(result).toEqual(data);
		});
	});

	// ── issueEdit ────────────────────────────────────────────────────
	describe("issueEdit", () => {
		it("edits title, body, and state", async () => {
			const exec = makeExec({ stdout: "Issue edited successfully" });
			const gh = createGh(exec);

			await gh.issueEdit({
				number: 1,
				title: "New title",
				body: "New body",
				state: "closed",
			});

			const args = exec.mock.calls[0][1];
			expect(args).toContain("--title");
			expect(args).toContain("New title");
			expect(args).toContain("--body");
			expect(args).toContain("New body");
			expect(args).toContain("--state");
			expect(args).toContain("closed");
		});

		it("adds and removes labels", async () => {
			const exec = makeExec({ stdout: "" });
			const gh = createGh(exec);

			await gh.issueEdit({
				number: 1,
				addLabels: ["bug"],
				removeLabels: ["wontfix"],
			});

			const args = exec.mock.calls[0][1];
			expect(args).toContain("--add-label");
			expect(args).toContain("bug");
			expect(args).toContain("--remove-label");
			expect(args).toContain("wontfix");
		});
	});

	// ── prEdit ───────────────────────────────────────────────────────
	describe("prEdit", () => {
		it("edits base branch", async () => {
			const exec = makeExec({ stdout: "" });
			const gh = createGh(exec);

			await gh.prEdit({ number: 1, base: "develop" });

			const args = exec.mock.calls[0][1];
			expect(args).toContain("--base");
			expect(args).toContain("develop");
		});
	});

	// ── getUser ──────────────────────────────────────────────────────
	describe("getUser", () => {
		it("extracts username from auth status", async () => {
			const exec = makeExec({ stdout: "✓ Logged in to github.com as miyake (user)\n" });
			const gh = createGh(exec);

			const result = await gh.getUser();
			expect(result).toEqual({ user: "miyake" });
		});

		it("returns 'unknown' when no user match found", async () => {
			const exec = makeExec({ stdout: "✓ Logged in to github.com\n" });
			const gh = createGh(exec);

			const result = await gh.getUser();
			expect(result).toEqual({ user: "unknown" });
		});
	});

	// ── Error handling ───────────────────────────────────────────────
	describe("error handling", () => {
		it("throws error with cleaned gh message", async () => {
			const exec = makeExec({ code: 1, stderr: "gh: not authenticated" });
			const gh = createGh(exec);

			await expect(gh.prList()).rejects.toThrow("gh pr list: not authenticated");
		});

		it("uses stdout when stderr is empty", async () => {
			const exec = makeExec({ code: 1, stdout: "gh: some error", stderr: "" });
			const gh = createGh(exec);

			await expect(gh.issueList()).rejects.toThrow("gh issue list: some error");
		});
	});
});