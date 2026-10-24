import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import blockProtectedCommit, {
	isGitCommitCommand,
	isProtectedBranch,
	shouldBlockCommit,
} from "../block-protected-commit";

describe("isProtectedBranch", () => {
	it.each(["main", "master", "development"])("protege %s", (branch) =>
		expect(isProtectedBranch(branch)).toBe(true),
	);

	it.each(["feature/x", "develop", "Main", "MASTER", "", "  "])(
		"não protege %s",
		(branch) => expect(isProtectedBranch(branch)).toBe(false),
	);

	it("não protege undefined/null", () => {
		expect(isProtectedBranch(undefined)).toBe(false);
		expect(isProtectedBranch(null)).toBe(false);
	});
});

describe("isGitCommitCommand", () => {
	it.each([
		"git commit -m \"msg\"",
		"git commit",
		"git -C /tmp commit -m msg",
		"git --no-pager commit -m msg",
		"sudo git commit -m msg",
		"git commit -m msg && echo ok",
		"echo ok; git commit -m msg",
		"GIT_AUTHOR_NAME=x git commit -m msg",
		"git -c user.name=x commit -m msg",
	])("detecta %s", (command) => expect(isGitCommitCommand(command)).toBe(true));

	it.each([
		"git push origin main",
		"git status",
		"git log --oneline",
		"git commit-tree HEAD -m msg",
		"npm test",
		"",
	])("ignora %s", (command) => expect(isGitCommitCommand(command)).toBe(false));
});

describe("shouldBlockCommit", () => {
	it("bloqueia commit em branch protegida", () => {
		expect(shouldBlockCommit("git commit -m msg", "main")).toBe(true);
		expect(shouldBlockCommit("git commit -m msg", "master")).toBe(true);
		expect(shouldBlockCommit("git commit -m msg", "development")).toBe(true);
	});

	it("permite commit em feature branch", () => {
		expect(shouldBlockCommit("git commit -m msg", "feat/x-123")).toBe(false);
	});

	it("permite não-commit mesmo em branch protegida", () => {
		expect(shouldBlockCommit("git status", "main")).toBe(false);
	});
});

describe("handler block-protected-commit", () => {
	const dirs: string[] = [];

	function initRepo(branch: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-commit-guard-"));
		dirs.push(dir);
		execSync("git init -q", { cwd: dir });
		execSync(`git checkout -q -b ${branch}`, { cwd: dir });
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function registerHandler() {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		blockProtectedCommit({
			on: vi.fn((event: string, handler: (...args: never[]) => unknown) =>
				handlers.set(event, handler),
			),
		} as never);
		return handlers.get("tool_call")!;
	}

	it("bloqueia git commit em branch protegida (incondicional, sem skill)", () => {
		const dir = initRepo("main");
		const handler = registerHandler();

		const result = handler({
			toolName: "bash",
			input: { command: `git -C ${dir} commit -m msg` },
		}) as { block: boolean; reason: string };

		expect(result).toEqual(expect.objectContaining({ block: true }));
		expect(result.reason).toMatch(/main/);
	});

	it("permite git commit em feature branch", () => {
		const dir = initRepo("feat/x-123");
		const handler = registerHandler();

		expect(
			handler({ toolName: "bash", input: { command: `git -C ${dir} commit -m msg` } }),
		).toBeUndefined();
	});

	it("ignora comandos que não são commit", () => {
		const dir = initRepo("main");
		const handler = registerHandler();

		expect(
			handler({ toolName: "bash", input: { command: `git -C ${dir} status` } }),
		).toBeUndefined();
	});

	it("ignora outras ferramentas", () => {
		const handler = registerHandler();
		expect(handler({ toolName: "read", input: { path: "x" } })).toBeUndefined();
	});
});
