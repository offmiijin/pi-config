import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectChanges, parseNumstat, parsePorcelainStatus, statusFromPorcelain } from "../git.ts";

function result(stdout: string, code = 0) {
	return { stdout, code };
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
		const runGit = async (args: string[]) => {
			calls.push(args);
			if (args.includes("status")) return result(" M z.ts\0?? a.ts\0");
			if (args.includes("rev-parse")) return result("head\n");
			if (args.includes("--numstat")) {
				return args.at(-1) === "a.ts" ? result("3\t0\ta.ts\n") : result("1\t2\tz.ts\n");
			}
			return args.at(-1) === "a.ts" ? result("+++ a.ts\n+new\n") : result("@@\n-old\n+new\n");
		};

		const snapshot = await collectChanges("/repo", runGit);
		expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
		expect(snapshot.files[0]).toMatchObject({ additions: 3, deletions: 0, diff: expect.stringContaining("+new") });
		expect(snapshot.totalAdditions).toBe(4);
		expect(snapshot.totalDeletions).toBe(2);
		expect(calls.some((args) => args.includes("--no-index"))).toBe(true);
	});

	it("lê o conteúdo atual do arquivo para a visualização", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-panel-"));
		writeFileSync(join(cwd, "src.ts"), "const current = true;\n");

		try {
			const snapshot = await collectChanges(cwd, async (args) => {
				if (args.includes("status")) return result(" M src.ts\0");
				if (args.includes("rev-parse")) return result("head\n");
				if (args.includes("--numstat")) return result("1\t0\tsrc.ts\n");
				return result("@@\n+const current = true;\n");
			});

			expect(snapshot.files[0]?.content).toBe("const current = true;\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("retorna erro quando o diretório não é um repositório", async () => {
		const snapshot = await collectChanges("/tmp", async () => ({
			stdout: "",
			stderr: "fatal: not a git repository",
			code: 128,
		}));
		expect(snapshot.files).toEqual([]);
		expect(snapshot.error).toContain("not a git repository");
	});
});
