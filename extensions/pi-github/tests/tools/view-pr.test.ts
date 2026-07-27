/**
 * Tests for tools/view-pr.ts
 */

import { describe, it, expect, vi } from "vitest";
import { viewPrTool } from "../../tools/view-pr";

function makeGh() {
	return {
		prCreate: vi.fn(), prList: vi.fn(), prView: vi.fn(), prEdit: vi.fn(),
		issueCreate: vi.fn(), issueList: vi.fn(), issueView: vi.fn(), issueEdit: vi.fn(),
		search: vi.fn(), getUser: vi.fn(),
	};
}

describe("viewPrTool", () => {
	it("displays PR details with labels, assignees, and comments", async () => {
		const gh = makeGh();
		gh.prView.mockResolvedValue({
			number: 5, title: "Add login", body: "## Changes\n\nLogin flow implemented.",
			state: "OPEN", headRefName: "feat/auth", baseRefName: "main",
			url: "https://github.com/owner/repo/pull/5",
			author: { login: "miyake" },
			createdAt: "2024-06-01T10:00:00Z",
			mergeable: "MERGEABLE",
			labels: [{ name: "feature" }, { name: "needs-review" }],
			assignees: [{ login: "user1" }],
			comments: [
				{ author: { login: "reviewer" }, body: "LGTM!", createdAt: "2024-06-02T08:00:00Z" },
			],
		});

		const tool = viewPrTool(gh);
		const result = await tool.execute("v1", { number: 5 }, undefined, undefined, undefined);

		const text = result.content[0].text;
		expect(text).toContain("#5");
		expect(text).toContain("Add login");
		expect(text).toContain("Mergeável");
		expect(text).toContain("✅ sim");
		expect(text).toContain("feature");
		expect(text).toContain("needs-review");
		expect(text).toContain("user1");
		expect(text).toContain("reviewer");
		expect(text).toContain("LGTM!");
		expect(text).toContain("Login flow implemented");
	});

	it("shows 'Sem descrição' when body is empty", async () => {
		const gh = makeGh();
		gh.prView.mockResolvedValue({
			number: 1, title: "Empty PR", body: "",
			state: "OPEN", headRefName: "f/e", baseRefName: "main",
			url: "https://github.com/owner/repo/pull/1",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			mergeable: "UNKNOWN", labels: [], assignees: [], comments: [],
		});

		const tool = viewPrTool(gh);
		const result = await tool.execute("v2", { number: 1 }, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("Sem descrição");
	});

	it("passes repo param", async () => {
		const gh = makeGh();
		gh.prView.mockResolvedValue({
			number: 2, title: "PR", body: "b", state: "OPEN",
			headRefName: "f", baseRefName: "main",
			url: "https://github.com/o/r/pull/2",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			mergeable: "MERGEABLE", labels: [], assignees: [], comments: [],
		});

		const tool = viewPrTool(gh);
		await tool.execute("v3", { number: 2, repo: "owner/name" }, undefined, undefined, undefined);

		expect(gh.prView).toHaveBeenCalledWith({ number: 2, repo: "owner/name" });
	});

	it("returns error on gh failure", async () => {
		const gh = makeGh();
		gh.prView.mockRejectedValue(new Error("PR not found"));

		const tool = viewPrTool(gh);
		const result = await tool.execute("v4", { number: 999 }, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("PR not found");
		expect(result.content[0].text).toContain("#999");
	});

	it("shows no comments section when comments array is empty", async () => {
		const gh = makeGh();
		gh.prView.mockResolvedValue({
			number: 3, title: "No comments", body: "body",
			state: "OPEN", headRefName: "f", baseRefName: "main",
			url: "https://github.com/o/r/pull/3",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			mergeable: "CONFLICTING", labels: [], assignees: [], comments: [],
		});

		const tool = viewPrTool(gh);
		const result = await tool.execute("v5", { number: 3 }, undefined, undefined, undefined);

		expect(result.content[0].text).not.toContain("Comentários");
		expect(result.content[0].text).toContain("conflitos");
	});
});
