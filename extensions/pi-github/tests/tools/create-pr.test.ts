/**
 * Tests for tools/create-pr.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createPrTool } from "../../tools/create-pr";

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

describe("createPrTool", () => {
	it("creates a PR with valid params and returns success", async () => {
		const gh = makeGh();
		gh.prCreate.mockResolvedValue({ url: "https://github.com/owner/repo/pull/42", number: 42 });

		const tool = createPrTool(gh);
		const result = await tool.execute("c1", {
			type: "feat", scope: "auth", title: "Add login",
			body: "## Description", head: "feat/auth",
		}, undefined, undefined, undefined);

		expect(result.content[0].text).toContain("#42");
		expect(result.content[0].text).toContain("feat(auth): Add login");
		expect(result.content[0].text).toContain("feat/auth");
		expect(result.isError).toBeFalsy();
		expect(gh.prCreate).toHaveBeenCalledWith({
			title: "feat(auth): Add login",
			body: "## Description", head: "feat/auth", base: "main",
		});
	});

	it("handles draft and taskNumber", async () => {
		const gh = makeGh();
		gh.prCreate.mockResolvedValue({ url: "https://github.com/owner/repo/pull/7", number: 7 });

		const tool = createPrTool(gh);
		await tool.execute("c2", {
			type: "fix", scope: "api", title: "Fix bug",
			body: "", head: "fix/api",
			taskNumber: 123, draft: true, base: "develop",
		}, undefined, undefined, undefined);

		expect(gh.prCreate).toHaveBeenCalledWith({
			title: "fix(api): Fix bug #123",
			body: "", head: "fix/api", base: "develop", draft: true,
		});
	});

	it("returns error when title validation fails (empty scope throws)", async () => {
		const gh = makeGh();
		const tool = createPrTool(gh);
		const result = await tool.execute("c3", {
			type: "feat", scope: "", title: "No scope",
			body: "", head: "feat/x",
		}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Escopo é obrigatório");
		expect(gh.prCreate).not.toHaveBeenCalled();
	});

	it("returns error when gh call fails", async () => {
		const gh = makeGh();
		gh.prCreate.mockRejectedValue(new Error("API error"));

		const tool = createPrTool(gh);
		const result = await tool.execute("c4", {
			type: "feat", scope: "core", title: "Test",
			body: "", head: "feat/test",
		}, undefined, undefined, undefined);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("API error");
	});
});
