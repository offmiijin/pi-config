/**
 * Tests for tools/edit-issue.ts
 */

import { describe, it, expect, vi } from "vitest";
import { editIssueTool } from "../../tools/edit-issue";

function makeGh() {
	return {
		prCreate: vi.fn(), prList: vi.fn(), prView: vi.fn(), prEdit: vi.fn(),
		issueCreate: vi.fn(), issueList: vi.fn(), issueView: vi.fn(), issueEdit: vi.fn(),
		search: vi.fn(), getUser: vi.fn(),
	};
}

describe("editIssueTool", () => {
	it("edits basic fields (title, body, state)", async () => {
		const gh = makeGh();
		gh.issueEdit.mockResolvedValue("ok");

		const tool = editIssueTool(gh);
		const result = await tool.execute("e1", {
			number: 1, title: "New title", body: "New body", state: "closed",
		}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#1");
		expect(result.content[0].text).toContain("título");
		expect(result.content[0].text).toContain("body");
		expect(result.content[0].text).toContain("estado → closed");
		expect(gh.issueView).not.toHaveBeenCalled(); // no labels/assignees = no diff
	});

	it("computes label diff when labels are provided", async () => {
		const gh = makeGh();
		gh.issueView.mockResolvedValue({
			number: 1, title: "Original", body: "",
			state: "OPEN", url: "https://github.com/o/r/issues/1",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			labels: [{ name: "bug" }, { name: "old-label" }],
			assignees: [{ login: "user1" }],
			comments: [],
		});
		gh.issueEdit.mockResolvedValue("ok");

		const tool = editIssueTool(gh);
		await tool.execute("e2", {
			number: 1, labels: ["bug", "new-label"],
		}, undefined, undefined, undefined);

		expect(gh.issueView).toHaveBeenCalledWith({ number: 1, repo: undefined });
		expect(gh.issueEdit).toHaveBeenCalledWith({
			number: 1, repo: undefined,
			addLabels: ["new-label"],
			removeLabels: ["old-label"],
			addAssignees: undefined,
			removeAssignees: undefined,
		});
	});

	it("computes assignee diff when assignees are provided", async () => {
		const gh = makeGh();
		gh.issueView.mockResolvedValue({
			number: 2, title: "T", body: "", state: "OPEN",
			url: "https://github.com/o/r/issues/2",
			author: { login: "u" }, createdAt: "2024-01-01T00:00:00Z",
			labels: [], assignees: [{ login: "user1" }, { login: "user2" }], comments: [],
		});
		gh.issueEdit.mockResolvedValue("ok");

		const tool = editIssueTool(gh);
		await tool.execute("e3", {
			number: 2, assignees: ["user1", "user3"],
		}, undefined, undefined, undefined);

		expect(gh.issueEdit).toHaveBeenCalledWith({
			number: 2, repo: undefined,
			addLabels: undefined, removeLabels: undefined,
			addAssignees: ["user3"],
			removeAssignees: ["user2"],
		});
	});

	it("returns error on gh failure during edit", async () => {
		const gh = makeGh();
		gh.issueEdit.mockRejectedValue(new Error("edit failed"));

		const tool = editIssueTool(gh);
		const result = await tool.execute("e4", {
			number: 1, title: "New",
		}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("edit failed");
	});

	it("shows no changes when no fields provided", async () => {
		const gh = makeGh();
		gh.issueEdit.mockResolvedValue("ok");

		const tool = editIssueTool(gh);
		const result = await tool.execute("e5", { number: 1 }, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("nenhuma");
	});
});
