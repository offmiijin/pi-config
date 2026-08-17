/** Criação e remoção de worktrees temporários do dev-sandbox. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { SandboxSession } from "./session";

export const DEFAULT_WORKTREE_ROOT = "/tmp/pi-worktrees";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function safeId(): string {
  return randomUUID().replace(/[^a-zA-Z0-9-]/g, "");
}

function assertManagedPath(root: string, path: string): void {
  const managed = resolve(root) + "/";
  const candidate = resolve(path);
  if (!candidate.startsWith(managed)) {
    throw new Error(`[dev-sandbox] Worktree fora da área gerenciada: ${path}`);
  }
}

/** Cria worktree temporário em branch própria baseado no HEAD atual. */
export function createWorktree(originalCwd: string, root = DEFAULT_WORKTREE_ROOT): SandboxSession {
  const original = resolve(originalCwd);
  const gitRoot = git(original, ["rev-parse", "--show-toplevel"]);
  const sessionId = safeId();
  const worktreePath = join(resolve(root), sessionId);
  const branchName = `sandbox/${sessionId}`;

  mkdirSync(resolve(root), { recursive: true, mode: 0o700 });
  assertManagedPath(root, worktreePath);

  try {
    // Branch temporária permite identificar e remover refs criadas pela sessão.
    git(gitRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
  } catch (error) {
    rmSync(worktreePath, { recursive: true, force: true });
    throw new Error(`[dev-sandbox] Falha ao criar worktree temporário: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    sessionId,
    originalCwd: original,
    workspaceCwd: worktreePath,
    worktreeRoot: resolve(root),
    gitRoot,
    branchName,
    worktreePath,
    startedAt: new Date().toISOString(),
  };
}

/** Remove worktree e branch criados por createWorktree. Seguro repetir. */
export function cleanupWorktree(session: SandboxSession): void {
  assertManagedPath(session.worktreeRoot, session.worktreePath);

  if (existsSync(session.worktreePath)) {
    try {
      git(session.gitRoot, ["worktree", "remove", "--force", session.worktreePath]);
    } catch {
      rmSync(session.worktreePath, { recursive: true, force: true });
    }
  }

  try {
    git(session.gitRoot, ["branch", "-D", session.branchName]);
  } catch {
    // Branch já removida ou nunca criada: cleanup idempotente.
  }

  rmSync(session.worktreePath, { recursive: true, force: true });
}

/** Verifica se diretório está sob raiz de worktrees gerenciados. */
export function isManagedWorktreePath(path: string, root = DEFAULT_WORKTREE_ROOT): boolean {
  const candidate = resolve(path);
  return candidate.startsWith(resolve(root) + "/");
}
