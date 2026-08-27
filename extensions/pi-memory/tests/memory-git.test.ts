/** Testes do repositório Git aninhado de memórias. */

import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "./expect-shim.ts";
import {
	MEMORY_GITIGNORE,
	MemoryGitRepository,
	formatMemoryCommitMessage,
} from "../memory/memory-git.ts";

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("formatMemoryCommitMessage", () => {
	it("gera mensagem estável com escopo e projeto", () => {
		expect(
			formatMemoryCommitMessage({
				projectId: "github-offmiijin_offmiijin_pi-config",
				scope: "project",
				type: "decisions",
				action: "atualiza",
				context: "pi-memory-git",
			}),
		).toBe("[github-offmiijin_offmiijin_pi-config] mem(projects/decisions): atualiza pi-memory-git");
	});

	it("remove quebras de linha e limita o assunto", () => {
		const message = formatMemoryCommitMessage({
			projectId: "projeto\nmalicioso",
			scope: "global",
			type: "gotchas",
			action: "cria",
			context: "x".repeat(200),
		});
		expect(message.includes("\n")).toBeFalse();
		expect(message).toContain("[global] mem(_global/gotchas): cria");
	});
});

describe("MemoryGitRepository", () => {
	it("inicializa com baseline e versiona somente os paths informados", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-git-"));
		try {
			const active = join(root, "projects", "p", "decisions", "cache.md");
			mkdirSync(join(active, ".."), { recursive: true });
			writeFileSync(active, "memória inicial\n");
			const repo = new MemoryGitRepository(root);

			const initialized = repo.initialize();
			expect(initialized.ok).toBeTrue();
			expect(initialized.action).toBe("initialized");
			expect(existsSync(join(root, ".git"))).toBeTrue();
			expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(MEMORY_GITIGNORE);
			expect(git(["status", "--porcelain"], root)).toBe("");

			writeFileSync(active, "memória atualizada\n");
			const committed = repo.commit(
				[active],
				"[p] mem(projects/decisions): atualiza cache",
			);
			expect(committed.ok).toBeTrue();
			expect(committed.action).toBe("committed");
			expect(git(["log", "-1", "--format=%s"], root).trim()).toBe(
				"[p] mem(projects/decisions): atualiza cache",
			);
			expect(git(["status", "--porcelain"], root)).toBe("");

			writeFileSync(join(root, ".pipeline.sqlite"), "derivado\n");
			expect(repo.commit(["."], "não deve commitar banco").action).toBe("noop");
			expect(repo.grep("termo-inexistente")).toBe("");
			expect(git(["status", "--porcelain"], root)).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
