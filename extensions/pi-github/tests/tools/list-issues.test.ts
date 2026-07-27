/**
 * Tests for tools/list-issues.ts
 */

import { describe, it, expect, vi } from "vitest";
import { listIssuesTool } from "../../tools/list-issues";

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

const MOCK_ISSUES = [
	{
		number: 5, title: "Bug report", state: "OPEN" as const,
		url: "https://github.com/owner/repo/issues/5",
		author: { login: "user1" },
		createdAt: "2024-02-01T12:00:00Z",
		labels: [{ name: "bug" }, { name: "high" }],
	},
	{
		number: 6, title: "Feature request", state: "CLOSED" as const,
		url: "https://github.com/owner/repo/issues/6",
		author: { login: "user2" },
		createdAt: "2024-01-20T09:00:00Z",
		labels: [{ name: "enhancement" }],
	},
];

describe("listIssuesTool", () => {
	it("lists issues with labels in output", async () => {
		const gh = makeGh();
		gh.issueList.mockResolvedValue(MOCK_ISSUES);

		const tool = listIssuesTool(gh);
		const result = await tool.execute("l1", {}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#5");
		expect(result.content[0].text).toContain("Bug report");
		expect(result.content[0].text).toContain("#6");
		expect(result.content[0].text).toContain("Feature request");
		expect(result.content[0].text).toContain("bug, high");
		expect(result.content[0].text).toContain("enhancement");
	});

	it("shows empty message when no issues", async () => {
		const gh = makeGh();
		gh.issueList.mockResolvedValue([]);

		const tool = listIssuesTool(gh);
		const result = await tool.execute("l2", {}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("Nenhuma issue");
	});

	it("passes label filter", async () => {
		const gh = makeGh();
		gh.issueList.mockResolvedValue([]);

		const tool = listIssuesTool(gh);
		await tool.execute("l3", { labels: ["bug"] }, undefined, undefined, undefined);

		expect(gh.issueList).toHaveBeenCalledWith({ state: undefined, limit: 10, labels: ["bug"] });
	});

	it("shows label filter in header when filtering by label", async () => {
		const gh = makeGh();
		gh.issueList.mockResolvedValue(MOCK_ISSUES);

		const tool = listIssuesTool(gh);
		const result = await tool.execute("l4", { labels: ["bug"] }, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("bug");
	});

	it("returns error on gh failure", async () => {
		const gh = makeGh();
		gh.issueList.mockRejectedValue(new Error("network error"));

		const tool = listIssuesTool(gh);
		const result = await tool.execute("l5", {}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("network error");
	});
});
