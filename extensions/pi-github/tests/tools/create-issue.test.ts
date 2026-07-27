/**
 * Tests for tools/create-issue.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createIssueTool } from "../../tools/create-issue";

function makeGh() {
	return {
		prCreate: vi.fn(),
		prList: vi.fn(),
		prView: vi.fn(),
		prEdit: vi.fn(),
		issueCreate: vi.fn(),
		issueList: vi.fn(),
		issueView: vi.fn(),
		issueEdit: vi.fn(),
		search: vi.fn(),
		getUser: vi.fn(),
	};
}

describe("createIssueTool", () => {
	it("creates issue with labels and assignees", async () => {
		const gh = makeGh();
		gh.issueCreate.mockResolvedValue({ url: "https://github.com/owner/repo/issues/10", number: 10 });

		const tool = createIssueTool(gh);
		const result = await tool.execute("c1", {
			type: "fix", scope: "auth", title: "Fix login bug",
			body: "Details", labels: ["bug", "urgent"], assignees: ["user1"],
		}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#10");
		expect(result.content[0].text).toContain("fix(auth): Fix login bug");
		expect(result.content[0].text).toContain("bug, urgent");
		expect(result.content[0].text).toContain("user1");
		expect(gh.issueCreate).toHaveBeenCalledWith({
			title: "fix(auth): Fix login bug",
			body: "Details",
			labels: ["bug", "urgent"],
			assignees: ["user1"],
		});
	});

	it("returns error on invalid title (empty scope throws)", async () => {
		const gh = makeGh();
		const tool = createIssueTool(gh);
		const result = await tool.execute("c2", {
			type: "feat", scope: "", title: "No scope",
			body: "", labels: [],
		}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Escopo é obrigatório");
		expect(gh.issueCreate).not.toHaveBeenCalled();
	});

	it("returns error on gh failure", async () => {
		const gh = makeGh();
		gh.issueCreate.mockRejectedValue(new Error("rate limited"));

		const tool = createIssueTool(gh);
		const result = await tool.execute("c3", {
			type: "docs", scope: "readme", title: "Update docs",
			body: "New docs", labels: ["documentation"],
		}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("rate limited");
	});

	it("omits assignees line when not provided", async () => {
		const gh = makeGh();
		gh.issueCreate.mockResolvedValue({ url: "https://github.com/owner/repo/issues/1", number: 1 });

		const tool = createIssueTool(gh);
		const result = await tool.execute("c4", {
			type: "chore", scope: "ci", title: "Add workflow",
			body: "", labels: ["ci"],
		}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#1");
		expect(result.content[0].text).not.toContain("Assignees");
	});
});
