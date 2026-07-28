/**
 * Tests for tools/list-prs.ts
 */

import { describe, it, expect, vi } from "vitest";
import { listPrsTool } from "../../tools/list-prs";

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

const MOCK_PRS = [
	{
		number: 1, title: "Add feature", state: "OPEN" as const,
		headRefName: "feat/x", baseRefName: "main",
		url: "https://github.com/owner/repo/pull/1",
		author: { login: "user1" },
		createdAt: "2024-01-15T10:00:00Z",
	},
	{
		number: 2, title: "Fix bug", state: "MERGED" as const,
		headRefName: "fix/y", baseRefName: "main",
		url: "https://github.com/owner/repo/pull/2",
		author: { login: "user2" },
		createdAt: "2024-01-10T08:00:00Z",
	},
];

describe("listPrsTool", () => {
	it("lists PRs with formatted output", async () => {
		const gh = makeGh();
		gh.prList.mockResolvedValue(MOCK_PRS);

		const tool = listPrsTool(gh);
		const result = await tool.execute("l1", {}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#1");
		expect(result.content[0].text).toContain("Add feature");
		expect(result.content[0].text).toContain("#2");
		expect(result.content[0].text).toContain("Fix bug");
		expect(result.content[0].text).toContain("user1");
		expect(result.content[0].text).toContain("user2");
		expect(gh.prList).toHaveBeenCalledWith({ state: undefined, limit: 10, author: undefined });
	});

	it("shows empty message when no PRs", async () => {
		const gh = makeGh();
		gh.prList.mockResolvedValue([]);

		const tool = listPrsTool(gh);
		const result = await tool.execute("l2", {}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("Nenhum pull request");
	});

	it("passes filter params", async () => {
		const gh = makeGh();
		gh.prList.mockResolvedValue([]);

		const tool = listPrsTool(gh);
		await tool.execute("l3", { state: "closed", limit: 5, author: "miyake" }, undefined, undefined, undefined);

		expect(gh.prList).toHaveBeenCalledWith({ state: "closed", limit: 5, author: "miyake" });
	});

	it("includes author in header when filtering by author", async () => {
		const gh = makeGh();
		gh.prList.mockResolvedValue(MOCK_PRS);

		const tool = listPrsTool(gh);
		const result = await tool.execute("l4", { author: "user1" }, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("@user1");
	});

	it("returns error on gh failure", async () => {
		const gh = makeGh();
		gh.prList.mockRejectedValue(new Error("not authenticated"));

		const tool = listPrsTool(gh);
		const result = await tool.execute("l5", {}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not authenticated");
	});
});
