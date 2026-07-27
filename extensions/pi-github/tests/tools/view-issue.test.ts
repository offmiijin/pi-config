/**
 * Tests for tools/view-issue.ts
 */

import { describe, it, expect, vi } from "vitest";
import { viewIssueTool } from "../../tools/view-issue";

function makeGh() {
	return {
		prCreate: vi.fn(), prList: vi.fn(), prView: vi.fn(), prEdit: vi.fn(),
		issueCreate: vi.fn(), issueList: vi.fn(), issueView: vi.fn(), issueEdit: vi.fn(),
		search: vi.fn(), getUser: vi.fn(),
	};
}

describe("viewIssueTool", () => {
	it("displays issue details with labels, assignees, and comments", async () => {
		const gh = makeGh();
		gh.issueView.mockResolvedValue({
			number: 10, title: "Bug: Login fails", body: "## Steps\n\n1. Open login",
			state: "OPEN", url: "https://github.com/owner/repo/issues/10",
			author: { login: "reporter" },
			createdAt: "2024-03-15T14:00:00Z",
			labels: [{ name: "bug" }, { name: "high-priority" }],
			assignees: [{ login: "dev1" }],
			comments: [
				{ author: { login: "dev1" }, body: "Looking into it", createdAt: "2024-03-16T09:00:00Z" },
			],
		});

		const tool = viewIssueTool(gh);
		const result = await tool.execute("v1", { number: 10 }, undefined, undefined, undefined);

		const text = result.content[0].text;
		expect(text).toContain("#10");
		expect(text).toContain("Bug: Login fails");
		expect(text).toContain("bug");
		expect(text).toContain("high-priority");
		expect(text).toContain("dev1");
		expect(text).toContain("reporter");
		expect(text).toContain("Looking into it");
		expect(text).toContain("1. Open login");
	});

	it("shows 'Sem descrição' when body is empty", async () => {
		const gh = makeGh();
		gh.issueView.mockResolvedValue({
			number: 2, title: "Empty issue", body: "",
			state: "CLOSED", url: "https://github.com/o/r/issues/2",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			labels: [], assignees: [], comments: [],
		});

		const tool = viewIssueTool(gh);
		const result = await tool.execute("v2", { number: 2 }, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("Sem descrição");
	});

	it("passes repo param", async () => {
		const gh = makeGh();
		gh.issueView.mockResolvedValue({
			number: 3, title: "I", body: "b", state: "OPEN",
			url: "https://github.com/o/r/issues/3",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			labels: [], assignees: [], comments: [],
		});

		const tool = viewIssueTool(gh);
		await tool.execute("v3", { number: 3, repo: "owner/name" }, undefined, undefined, undefined);

		expect(gh.issueView).toHaveBeenCalledWith({ number: 3, repo: "owner/name" });
	});

	it("returns error on gh failure", async () => {
		const gh = makeGh();
		gh.issueView.mockRejectedValue(new Error("Issue not found"));

		const tool = viewIssueTool(gh);
		const result = await tool.execute("v4", { number: 999 }, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Issue not found");
	});
});
