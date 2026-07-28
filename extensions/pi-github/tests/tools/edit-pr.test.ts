/**
 * Tests for tools/edit-pr.ts
 */

import { describe, it, expect, vi } from "vitest";
import { editPrTool } from "../../tools/edit-pr";

function makeGh() {
	return {
		prCreate: vi.fn(), prList: vi.fn(), prView: vi.fn(), prEdit: vi.fn(),
		issueCreate: vi.fn(), issueList: vi.fn(), issueView: vi.fn(), issueEdit: vi.fn(),
		search: vi.fn(), getUser: vi.fn(),
	};
}

describe("editPrTool", () => {
	it("edits basic fields (title, body, base)", async () => {
		const gh = makeGh();
		gh.prEdit.mockResolvedValue("ok");

		const tool = editPrTool(gh);
		const result = await tool.execute("e1", {
			number: 5, title: "New title", body: "New body", base: "develop",
		}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#5");
		expect(result.content[0].text).toContain("título");
		expect(result.content[0].text).toContain("body");
		expect(result.content[0].text).toContain("base → develop");
	});

	it("computes label diff when labels are provided", async () => {
		const gh = makeGh();
		gh.prView.mockResolvedValue({
			number: 1, title: "PR", body: "", state: "OPEN",
			headRefName: "f", baseRefName: "main",
			url: "https://github.com/o/r/pull/1",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			mergeable: "MERGEABLE",
			labels: [{ name: "bug" }, { name: "old-label" }],
			assignees: [{ login: "user1" }],
			comments: [],
		});
		gh.prEdit.mockResolvedValue("ok");

		const tool = editPrTool(gh);
		await tool.execute("e2", {
			number: 1, labels: ["bug", "new-label"],
		}, undefined, undefined, undefined);

		expect(gh.prView).toHaveBeenCalledWith({ number: 1, repo: undefined });
		expect(gh.prEdit).toHaveBeenCalledWith({
			number: 1, repo: undefined,
			addLabels: ["new-label"],
			removeLabels: ["old-label"],
			addAssignees: undefined,
			removeAssignees: undefined,
		});
	});

	it("computes assignee diff", async () => {
		const gh = makeGh();
		gh.prView.mockResolvedValue({
			number: 2, title: "T", body: "", state: "OPEN",
			headRefName: "f", baseRefName: "main",
			url: "https://github.com/o/r/pull/2",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			mergeable: "MERGEABLE",
			labels: [], assignees: [{ login: "user1" }, { login: "user2" }],
			comments: [],
		});
		gh.prEdit.mockResolvedValue("ok");

		const tool = editPrTool(gh);
		await tool.execute("e3", {
			number: 2, assignees: ["user1", "user3"],
		}, undefined, undefined, undefined);

		expect(gh.prEdit).toHaveBeenCalledWith({
			number: 2, repo: undefined,
			addLabels: undefined, removeLabels: undefined,
			addAssignees: ["user3"],
			removeAssignees: ["user2"],
		});
	});

	it("returns error on gh failure", async () => {
		const gh = makeGh();
		gh.prEdit.mockRejectedValue(new Error("edit failed"));

		const tool = editPrTool(gh);
		const result = await tool.execute("e4", {
			number: 1, title: "New",
		}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("edit failed");
	});

	it("shows milestone change", async () => {
		const gh = makeGh();
		gh.prEdit.mockResolvedValue("ok");

		const tool = editPrTool(gh);
		const result = await tool.execute("e5", {
			number: 1, milestone: "v2.0",
		}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("v2.0");
	});
});
