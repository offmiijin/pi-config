/** Criação, remoção e recuperação de worktrees temporários. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { SandboxSession } from "./session";

export const DEFAULT_WORKTREE_ROOT = "/tmp/pi-worktrees";
const METADATA_FILE = ".pi-sandbox-worktree.json";
type WorktreeMetadata = Pick<SandboxSession, "sessionId" | "gitRoot" | "branchName" | "worktreePath" | "worktreeRoot" | "startedAt"> & { pid: number };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function safeId(): string { return randomUUID().replace(/[^a-zA-Z0-9-]/g, ""); }
function assertManagedPath(root: string, path: string): void {
  if (!resolve(path).startsWith(resolve(root) + "/")) throw new Error(`[dev-sandbox] Worktree fora da área gerenciada: ${path}`);
}
function writeMetadata(session: SandboxSession): void {
  const metadata: WorktreeMetadata = { ...session, pid: process.pid };
  writeFileSync(join(session.worktreePath, METADATA_FILE), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
}

/** Remove worktrees antigos cujo metadata pertence a processo encerrado. */
export function cleanupOrphanedWorktrees(root = DEFAULT_WORKTREE_ROOT): number {
  const worktreeRoot = resolve(root);
  if (!existsSync(worktreeRoot)) return 0;
  let removed = 0;
  for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(worktreeRoot, entry.name);
    try {
      const metadata = JSON.parse(readFileSync(join(path, METADATA_FILE), "utf8")) as WorktreeMetadata;
      assertManagedPath(worktreeRoot, metadata.worktreePath);
      if (metadata.worktreeRoot !== worktreeRoot || metadata.pid === process.pid) continue;
      try { process.kill(metadata.pid, 0); continue; } catch (error: any) { if (error?.code === "EPERM") continue; if (error?.code !== "ESRCH") continue; }
      cleanupWorktree({ ...metadata, originalCwd: metadata.gitRoot, workspaceCwd: path });
      removed++;
    } catch { /* metadata inválido ou órfão não removível: não apagar cegamente */ }
  }
  return removed;
}

/** Cria worktree temporário em branch própria baseado no HEAD atual. */
export function createWorktree(originalCwd: string, root = DEFAULT_WORKTREE_ROOT): SandboxSession {
  const original = resolve(originalCwd);
  const gitRoot = git(original, ["rev-parse", "--show-toplevel"]);
  const sessionId = safeId();
  const worktreeRoot = resolve(root);
  const worktreePath = join(worktreeRoot, sessionId);
  const branchName = `sandbox/${sessionId}`;
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
  assertManagedPath(worktreeRoot, worktreePath);
  try {
    git(gitRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
    const session: SandboxSession = { sessionId, originalCwd: original, workspaceCwd: worktreePath, worktreeRoot, gitRoot, branchName, worktreePath, startedAt: new Date().toISOString() };
    writeMetadata(session);
    return session;
  } catch (error) {
    rmSync(worktreePath, { recursive: true, force: true });
    throw new Error(`[dev-sandbox] Falha ao criar worktree temporário: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Remove worktree e branch criados por createWorktree. Seguro repetir. */
export function cleanupWorktree(session: SandboxSession): void {
  assertManagedPath(session.worktreeRoot, session.worktreePath);
  if (existsSync(session.worktreePath)) { try { git(session.gitRoot, ["worktree", "remove", "--force", session.worktreePath]); } catch { rmSync(session.worktreePath, { recursive: true, force: true }); } }
  try { git(session.gitRoot, ["branch", "-D", session.branchName]); } catch { /* já removida */ }
  rmSync(session.worktreePath, { recursive: true, force: true });
}
export function isManagedWorktreePath(path: string, root = DEFAULT_WORKTREE_ROOT): boolean { return resolve(path).startsWith(resolve(root) + "/"); }
