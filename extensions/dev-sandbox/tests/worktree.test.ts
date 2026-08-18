import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOrphanedWorktrees, cleanupWorktree, createWorktree, promoteWorktreeChanges } from "../worktree";
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
  it("recusa criar worktree aninhado na área gerenciada", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const original = join(root, "project");
    git(root, ["init", "-q", original]);

    expect(() => createWorktree(original, root)).toThrow(/worktree aninhado/);
  });

  it("recusa projeto original com alterações locais", () => {
    const original = repo();
    writeFileSync(join(original, "file.txt"), "dirty\n");
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));

    expect(() => createWorktree(original, root)).toThrow(/alterações locais/);
  });

  it("preserva subdiretório original dentro do worktree", () => {
    const rootRepo = repo();
    const original = join(rootRepo, "src");
    mkdirSync(original, { recursive: true });
    writeFileSync(join(original, "main.ts"), "original\n");
    git(rootRepo, ["add", "."]);
    git(rootRepo, ["commit", "-qm", "src"]);
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    sessions.push(session);

    expect(session.workspaceSubdir).toBe("src");
    expect(session.workspaceCwd).toBe(join(session.worktreePath, "src"));
    expect(readFileSync(join(session.workspaceCwd, "main.ts"), "utf8")).toBe("original\n");
  });

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

  it("preserva worktree com lease fresco mesmo com PID invisível", () => {
    const original = repo();
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    sessions.push(session);

    const metadataPath = join(session.worktreePath, ".pi-sandbox-worktree.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number };
    metadata.pid = 999999999;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const now = new Date();
    utimesSync(metadataPath, now, now);

    expect(cleanupOrphanedWorktrees(root, original)).toBe(0);
    expect(existsSync(session.worktreePath)).toBe(true);
  });

  it("remove registro Git órfão sem metadata", () => {
    const original = repo();
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    sessions.push(session);
    rmSync(join(session.worktreePath, ".pi-sandbox-worktree.json"));

    expect(cleanupOrphanedWorktrees(root, original)).toBe(1);
    expect(existsSync(session.worktreePath)).toBe(false);
    expect(git(original, ["branch", "--list", session.branchName])).toBe("");
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

  it("bloqueia promoção de untracked que escapa por symlink", () => {
    const original = repo();
    const root = mkdtempSync(join(tmpdir(), "dev-sandbox-worktrees-"));
    const session = createWorktree(original, root);
    sessions.push(session);
    const outside = mkdtempSync(join(tmpdir(), "dev-sandbox-outside-"));
    symlinkSync(outside, join(session.worktreePath, "redirect"));
    writeFileSync(join(outside, "secret.txt"), "secret\n");

    expect(() => promoteWorktreeChanges(session)).toThrow(/Origem de promoção/);
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
