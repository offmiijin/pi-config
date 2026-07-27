/**
 * Tests for tools/search.ts
 *
 * Covers: searchTool function and execute handler
 */

import { describe, it, expect, vi } from "vitest";
import { searchTool } from "../tools/search";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGh() {
	return {
		search: vi.fn(),
		prCreate: vi.fn(),
		prList: vi.fn(),
		prView: vi.fn(),
		prEdit: vi.fn(),
		issueCreate: vi.fn(),
		issueList: vi.fn(),
		issueView: vi.fn(),
		issueEdit: vi.fn(),
		getUser: vi.fn(),
	};
}

// ---------------------------------------------------------------------------
// searchTool
// ---------------------------------------------------------------------------
describe("searchTool", () => {
	it("returns search results as formatted text", async () => {
		const gh = makeGh();
		gh.search.mockResolvedValue([
			{
				number: 1,
				title: "Bug no login",
				state: "OPEN",
				url: "https://github.com/owner/repo/issues/1",
				repository: { nameWithOwner: "owner/repo" },
				createdAt: "2024-01-15T10:00:00Z",
			},
		]);

		const tool = searchTool(gh);
		const result = await tool.execute(
			"call-1",
			{ query: "bug login" },
			undefined,
			undefined,
			undefined,
		);

		expect(result.content[0].text).toContain("#1");
		expect(result.content[0].text).toContain("Bug no login");
		expect(result.content[0].text).toContain("owner/repo");
		expect(gh.search).toHaveBeenCalledWith({ query: "bug login", repo: undefined, state: undefined });
	});

	it("returns empty message when no results found", async () => {
		const gh = makeGh();
		gh.search.mockResolvedValue([]);

		const tool = searchTool(gh);
		const result = await tool.execute(
			"call-2",
			{ query: "nonexistent" },
			undefined,
			undefined,
			undefined,
		);

		expect(result.content[0].text).toContain("Nenhum resultado");
		expect(result.content[0].text).toContain("nonexistent");
	});

	it("passes repo and state filters", async () => {
		const gh = makeGh();
		gh.search.mockResolvedValue([]);

		const tool = searchTool(gh);
		await tool.execute(
			"call-3",
			{ query: "auth", repo: "owner/repo", state: "closed" },
			undefined,
			undefined,
			undefined,
		);

		expect(gh.search).toHaveBeenCalledWith({
			query: "auth",
			repo: "owner/repo",
			state: "closed",
		});
	});

	it("returns error result when search throws", async () => {
		const gh = makeGh();
		gh.search.mockRejectedValue(new Error("gh search: API rate limit exceeded"));

		const tool = searchTool(gh);
		const result = await tool.execute(
			"call-4",
			{ query: "test" },
			undefined,
			undefined,
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("API rate limit exceeded");
	});
});