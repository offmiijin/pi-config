import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectChanges,
	parseNameStatus,
	parseNumstat,
	parsePorcelainStatus,
	statusFromPorcelain,
	type GitResult,
} from "../git.ts";

function result(stdout: string, code = 0) {
	return { stdout, code };
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function runGit(args: string[]): Promise<GitResult> {
	try {
		return { stdout: execFileSync("git", args, { encoding: "utf8" }), code: 0 };
	} catch (error: any) {
		return {
			stdout: String(error?.stdout ?? ""),
			stderr: String(error?.stderr ?? ""),
			code: error?.status ?? 1,
		};
	}
}

describe("git — status", () => {
	it("interpreta arquivos modificados, adicionados e não rastreados", () => {
		const output = " M src/app.ts\0A  src/new.ts\0?? src/novo.ts\0";
		expect(parsePorcelainStatus(output)).toEqual([
			{ path: "src/app.ts", status: "M" },
			{ path: "src/new.ts", status: "A" },
			{ path: "src/novo.ts", status: "?" },
		]);
	});

	it("usa o caminho novo em renames e ignora o caminho anterior", () => {
		expect(parsePorcelainStatus("R  src/novo.ts\0src/antigo.ts\0")).toEqual([
			{ path: "src/novo.ts", status: "R" },
		]);
		expect(parseNameStatus("R100\0src/antigo.ts\0src/novo.ts\0")).toEqual([
			{ path: "src/novo.ts", status: "R" },
		]);
	});

	it("prioriza deleção e reconhece cópia", () => {
		expect(statusFromPorcelain("AMD")).toBe("D");
		expect(statusFromPorcelain("CC")).toBe("C");
	});
});

describe("git — numstat", () => {
	it("lê adições e remoções", () => {
		expect(parseNumstat("12\t4\tsrc/app.ts\n")).toEqual({ additions: 12, deletions: 4 });
	});

	it("trata diff binário como zero linhas", () => {
		expect(parseNumstat("-\t-\timage.png\n")).toEqual({ additions: 0, deletions: 0 });
	});
});

describe("git — coleta", () => {
	it("combina status, estatísticas, diffs e totais", async () => {
		const calls: string[][] = [];
		const runner = async (args: string[]) => {
			calls.push(args);
			if (args.includes("status")) return result(" M z.ts\0?? a.ts\0");
			if (args.includes("rev-parse")) return result("head\n");
			if (args.includes("--numstat")) {
				return args.at(-1) === "a.ts" ? result("3\t0\ta.ts\n") : result("1\t2\tz.ts\n");
			}
			return args.at(-1) === "a.ts" ? result("+++ a.ts\n+new\n") : result("@@\n-old\n+new\n");
		};

		const snapshot = await collectChanges("/repo", runner);
		expect(snapshot.groups).toHaveLength(1);
		expect(snapshot.groups[0]?.label).toBe("Não commitadas");
		expect(snapshot.groups[0]?.files.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
		expect(snapshot.groups[0]?.files[0]).toMatchObject({ additions: 3, deletions: 0, diff: expect.stringContaining("+new") });
		expect(snapshot.totalAdditions).toBe(4);
		expect(snapshot.totalDeletions).toBe(2);
		expect(calls.some((args) => args.includes("--no-index"))).toBe(true);
	});

	it("separa cada commit da sessão e alterações não commitadas", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-panel-repo-"));
		try {
			git(cwd, ["init", "-q"]);
			git(cwd, ["config", "user.email", "panel@test.invalid"]);
			git(cwd, ["config", "user.name", "Panel Test"]);
			writeFileSync(join(cwd, "app.ts"), "const value = 1;\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-qm", "base"]);
			const baseCommit = git(cwd, ["rev-parse", "HEAD"]);

			writeFileSync(join(cwd, "app.ts"), "const value = 2;\n");
			git(cwd, ["add", "app.ts"]);
			git(cwd, ["commit", "-qm", "altera app"]);
			writeFileSync(join(cwd, "committed.ts"), "export const committed = true;\n");
			git(cwd, ["add", "committed.ts"]);
			git(cwd, ["commit", "-qm", "adiciona arquivo"]);
			writeFileSync(join(cwd, "working.ts"), "export const working = true;\n");

			const snapshot = await collectChanges(cwd, runGit, { baseCommit });

			expect(snapshot.error).toBeUndefined();
			expect(snapshot.groups.map((group) => group.kind)).toEqual(["commit", "commit", "working-tree"]);
			expect(snapshot.groups[0]?.label).toContain("altera app");
			expect(snapshot.groups[0]?.files[0]?.diff).toContain("-const value = 1;");
			expect(snapshot.groups[0]?.files[0]?.diff).toContain("+const value = 2;");
			expect(snapshot.groups[1]?.files.map((file) => file.path)).toEqual(["committed.ts"]);
			expect(snapshot.groups[2]?.files.map((file) => file.path)).toEqual(["working.ts"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("ignora o metadata interno do worktree", async () => {
		const snapshot = await collectChanges("/repo", async (args) => {
			if (args.includes("status")) return result("?? .pi-sandbox-worktree.json\0");
			return result("head\n");
		});
		expect(snapshot.groups).toEqual([]);
	});

	it("retorna erro quando o diretório não é um repositório", async () => {
		const snapshot = await collectChanges("/tmp", async () => ({
			stdout: "",
			stderr: "fatal: not a git repository",
			code: 128,
		}));
		expect(snapshot.groups).toEqual([]);
		expect(snapshot.error).toContain("not a git repository");
	});
});
