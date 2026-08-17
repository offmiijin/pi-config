import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, promoteWorktreeChanges } from "../worktree";
import type { SandboxSession } from "../session";

const sessions: SandboxSession[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-sandbox-repo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "sandbox@test.invalid"]);
  git(dir, ["config", "user.name", "Sandbox Test"]);
  writeFileSync(join(dir, "file.txt"), "original\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "initial"]);
  return dir;
}

afterEach(() => {
  for (const session of sessions.splice(0)) cleanupWorktree(session);
});

describe("worktree", () => {
  it("cria worktree temporário em branch própria", () => {
    const original = repo();
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    sessions.push(session);

    expect(session.originalCwd).toBe(original);
    expect(session.workspaceCwd).toBe(session.worktreePath);
    expect(session.gitRoot).toBe(original);
    expect(session.branchName).toMatch(/^sandbox\//);
    expect(readFileSync(join(session.workspaceCwd, "file.txt"), "utf8")).toBe("original\n");
    expect(git(session.workspaceCwd, ["branch", "--show-current"])).toBe(session.branchName);
  });

  it("promove alterações rastreadas e untracked", () => {
    const original = repo();
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    sessions.push(session);
    writeFileSync(join(session.workspaceCwd, "file.txt"), "promoted\n");
    writeFileSync(join(session.workspaceCwd, "new.txt"), "new\n");

    promoteWorktreeChanges(session);

    expect(readFileSync(join(original, "file.txt"), "utf8")).toBe("promoted\n");
    expect(readFileSync(join(original, "new.txt"), "utf8")).toBe("new\n");
  });

  it("remove worktree e branch de forma idempotente", () => {
    const original = repo();
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    writeFileSync(join(session.workspaceCwd, "file.txt"), "temporary\n");

    cleanupWorktree(session);
    cleanupWorktree(session);

    expect(existsSync(session.worktreePath)).toBe(false);
    expect(readFileSync(join(original, "file.txt"), "utf8")).toBe("original\n");
    expect(git(original, ["branch", "--list", session.branchName])).toBe("");
  });
});
