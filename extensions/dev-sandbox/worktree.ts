/** Criação, remoção e recuperação de worktrees temporários. */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SandboxSession } from "./session";

export const DEFAULT_WORKTREE_ROOT = "/tmp/pi-worktrees";
const METADATA_FILE = ".pi-sandbox-worktree.json";
export const WORKTREE_LEASE_INTERVAL_MS = 10_000;
export const WORKTREE_LEASE_STALE_MS = 60_000;
const activeLeases = new Map<string, NodeJS.Timeout>();
type WorktreeMetadata = Pick<SandboxSession, "sessionId" | "gitRoot" | "gitDir" | "branchName" | "originalBranchName" | "baseCommit" | "worktreePath" | "worktreeRoot" | "workspaceSubdir" | "workspaceCwd" | "startedAt"> & { pid: number };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitRootOrNull(cwd: string): string | null {
  try {
    return resolve(git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch (error: any) {
    const stderr = String(error?.stderr ?? "");
    if (error?.status === 128 && /not a git repository|não é um repositório git/i.test(stderr)) {
      return null;
    }
    throw error;
  }
}

function safeId(): string { return randomUUID().replace(/[^a-zA-Z0-9-]/g, ""); }

/** Retorna se o diretório pertence a um repositório Git. */
export function isGitRepository(cwd: string): boolean {
  return gitRootOrNull(resolve(cwd)) !== null;
}

function isPathWithin(base: string, target: string): boolean {
  const basePath = resolve(base);
  const targetPath = resolve(target);
  return targetPath === basePath || targetPath.startsWith(basePath + sep);
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first);
}

function assertManagedPath(root: string, path: string): void {
  if (!isPathWithin(root, path) || resolve(path) === resolve(root)) {
    throw new Error(`[dev-sandbox] Worktree fora da área gerenciada: ${path}`);
  }
}

function assertNotActiveWorktree(path: string): void {
  if (pathsOverlap(path, process.cwd())) {
    throw new Error(`[dev-sandbox] Recusa remover worktree ativo: ${path}`);
  }
}
function metadataPath(worktreePath: string): string {
  return join(worktreePath, METADATA_FILE);
}

function writeMetadata(session: SandboxSession): void {
  const metadata: WorktreeMetadata = { ...session, pid: process.pid };
  writeFileSync(metadataPath(session.worktreePath), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
}

function refreshLease(worktreePath: string): void {
  const now = new Date();
  try {
    utimesSync(metadataPath(worktreePath), now, now);
  } catch {
    // O worktree será tratado como órfão somente após o lease expirar.
  }
}

function startLease(worktreePath: string): void {
  refreshLease(worktreePath);
  const timer = setInterval(() => refreshLease(worktreePath), WORKTREE_LEASE_INTERVAL_MS);
  timer.unref();
  activeLeases.set(worktreePath, timer);
}

function stopLease(worktreePath: string): void {
  const timer = activeLeases.get(worktreePath);
  if (!timer) return;
  clearInterval(timer);
  activeLeases.delete(worktreePath);
}

function hasFreshLease(worktreePath: string, now = Date.now()): boolean {
  try {
    return now - statSync(metadataPath(worktreePath)).mtimeMs < WORKTREE_LEASE_STALE_MS;
  } catch {
    return false;
  }
}

/** Remove worktrees antigos cujo metadata pertence a processo encerrado. */
export function cleanupOrphanedWorktrees(root = DEFAULT_WORKTREE_ROOT, gitRoot?: string): number {
  const worktreeRoot = resolve(root);
  if (!existsSync(worktreeRoot)) return 0;
  let removed = 0;
  for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(worktreeRoot, entry.name);
    try {
      const metadata = JSON.parse(readFileSync(metadataPath(path), "utf8")) as WorktreeMetadata;
      assertManagedPath(worktreeRoot, metadata.worktreePath);
      if (metadata.worktreeRoot !== worktreeRoot || metadata.pid === process.pid) continue;
      if (pathsOverlap(metadata.worktreePath, process.cwd())) continue;
      if (hasFreshLease(path)) continue;
      try { process.kill(metadata.pid, 0); continue; } catch (error: any) { if (error?.code === "EPERM") continue; if (error?.code !== "ESRCH") continue; }
      cleanupWorktree({
        ...metadata,
        originalCwd: join(metadata.gitRoot, metadata.workspaceSubdir ?? ""),
        workspaceCwd: metadata.workspaceCwd ?? path,
      });
      removed++;
    } catch { /* metadata inválido ou órfão não removível: não apagar cegamente */ }
  }
  if (gitRoot) {
    const entries = git(gitRoot, ["worktree", "list", "--porcelain"]).split("\n");
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].startsWith("worktree ")) continue;
      const path = entries[i].slice("worktree ".length);
      const branchLine = entries.slice(i, i + 5).find((line) => line.startsWith("branch "));
      const branch = branchLine?.slice("branch ".length).replace("refs/heads/", "") ?? "";
      if (!isManagedWorktreePath(path, worktreeRoot) || !branch.startsWith("sandbox/")) continue;
      if (existsSync(join(path, METADATA_FILE))) continue;
      try {
        git(gitRoot, ["worktree", "remove", "--force", path]);
        try { git(gitRoot, ["branch", "-D", branch]); } catch { /* branch já removida */ }
        removed++;
      } catch { /* worktree inválido: não apagar fora do Git */ }
    }
  }
  return removed;
}

/**
 * Cria worktree temporário em branch própria baseado no HEAD atual.
 *
 * Projetos sem Git não podem usar worktree. Nesse caso, a própria raiz
 * aberta pelo usuário é usada como workspace do sandbox; nenhuma operação
 * Git ou limpeza de worktree é tentada.
 */
export function createWorktree(originalCwd: string, root = DEFAULT_WORKTREE_ROOT): SandboxSession {
  const original = resolve(originalCwd);
  const worktreeRoot = resolve(root);
  const gitRoot = gitRootOrNull(original);
  if (!gitRoot) {
    return {
      sessionId: safeId(),
      originalCwd: original,
      workspaceSubdir: "",
      workspaceCwd: original,
      worktreeRoot,
      gitRoot: "",
      gitDir: "",
      branchName: "",
      originalBranchName: "",
      baseCommit: "",
      worktreePath: original,
      startedAt: new Date().toISOString(),
    };
  }
  if (isPathWithin(worktreeRoot, original)) {
    throw new Error(
      `[dev-sandbox] Não é seguro criar worktree aninhado dentro da área gerenciada: ${original}`,
    );
  }
  const gitDirValue = git(original, ["rev-parse", "--git-common-dir"]);
  const gitDir = resolve(gitRoot, gitDirValue);
  const workspaceSubdir = relative(gitRoot, original);
  if (workspaceSubdir.startsWith("..") || resolve(gitRoot, workspaceSubdir) !== original) {
    throw new Error(`[dev-sandbox] CWD fora da raiz Git: ${original}`);
  }
  if (git(original, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error(
      `[dev-sandbox] O projeto original possui alterações locais. Faça commit ou stash antes de iniciar o sandbox: ${original}`,
    );
  }
  const sessionId = safeId();
  const worktreePath = join(worktreeRoot, sessionId);
  const originalBranchName = git(gitRoot, ["branch", "--show-current"]);
  const baseCommit = git(original, ["rev-parse", "HEAD"]);
  const branchName = `sandbox/${sessionId}`;
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
  assertManagedPath(worktreeRoot, worktreePath);
  try {
    git(gitRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
    const workspaceCwd = workspaceSubdir ? join(worktreePath, workspaceSubdir) : worktreePath;
    const session: SandboxSession = { sessionId, originalCwd: original, workspaceSubdir, workspaceCwd, worktreeRoot, gitRoot, gitDir, branchName, originalBranchName, baseCommit, worktreePath, startedAt: new Date().toISOString() };
    writeMetadata(session);
    startLease(session.worktreePath);
    return session;
  } catch (error) {
    rmSync(worktreePath, { recursive: true, force: true });
    throw new Error(`[dev-sandbox] Falha ao criar worktree temporário: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Remove worktree e branch criados por createWorktree. Seguro repetir. */
export function cleanupWorktree(session: SandboxSession): void {
  // Projetos sem Git usam a raiz original diretamente e não criam recursos
  // temporários para remover.
  if (!session.gitRoot || !session.branchName) return;
  assertManagedPath(session.worktreeRoot, session.worktreePath);
  assertNotActiveWorktree(session.worktreePath);
  restoreWorktreePreview(session);
  stopLease(session.worktreePath);
  if (existsSync(session.worktreePath)) { try { git(session.gitRoot, ["worktree", "remove", "--force", session.worktreePath]); } catch { rmSync(session.worktreePath, { recursive: true, force: true }); } }
  try { git(session.gitRoot, ["branch", "-D", session.branchName]); } catch { /* já removida */ }
  rmSync(session.worktreePath, { recursive: true, force: true });
}
function validateRelativeFile(file: string): string {
  const clean = file.trim();
  if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) {
    throw new Error(`[dev-sandbox] Caminho inválido para promoção: ${file}`);
  }
  return clean;
}

function assertRealPathInside(base: string, target: string, label: string): void {
  const baseReal = realpathSync(base);
  let existing = resolve(target);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  if (realExisting !== baseReal && !realExisting.startsWith(baseReal + sep)) {
    throw new Error(`[dev-sandbox] ${label} escapa da área permitida: ${target}`);
  }
}

interface PreviewSnapshot {
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

interface PreviewFileState {
  snapshot: PreviewSnapshot;
  promotedFingerprint: string;
}

interface PreviewState {
  files: Map<string, PreviewFileState>;
}

const previewStates = new Map<string, PreviewState>();

function selectedPath(path: string, selected: string[]): boolean {
  return selected.length === 0 || selected.some((file) => path === file || path.startsWith(file + "/"));
}

function fileFingerprint(path: string): string {
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (!stat.isFile()) return `non-file:${stat.mode}`;
  return `${stat.mode & 0o777}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function captureOriginalFile(session: SandboxSession, file: string): PreviewSnapshot {
  const target = join(session.gitRoot, file);
  assertRealPathInside(session.gitRoot, target, "Destino de promoção");
  if (!existsSync(target)) return { existed: false };
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new Error(`[dev-sandbox] Destino de promoção não é arquivo: ${file}`);
  return { existed: true, content: readFileSync(target), mode: stat.mode & 0o777 };
}

function restoreSnapshot(session: SandboxSession, file: string, snapshot: PreviewSnapshot): void {
  const target = join(session.gitRoot, file);
  assertRealPathInside(session.gitRoot, target, "Destino de restauração");
  if (!snapshot.existed) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, snapshot.content ?? Buffer.alloc(0));
  chmodSync(target, snapshot.mode ?? 0o644);
}

function changedWorktreeFiles(session: SandboxSession, selected: string[]): string[] {
  const pathspec = selected.length ? selected : ["."];
  const tracked = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", session.baseCommit, "--", ...pathspec], {
    cwd: session.worktreePath,
    encoding: "buffer",
  }).toString().split(String.fromCharCode(0)).filter(Boolean).map(validateRelativeFile);
  const untracked = git(session.worktreePath, ["ls-files", "--others", "--exclude-standard", "--", ...pathspec])
    .split("\n").filter((file) => Boolean(file) && file !== METADATA_FILE).map(validateRelativeFile);
  return [...new Set([...tracked, ...untracked])];
}

function applyWorktreeChanges(session: SandboxSession, selected: string[]): string[] {
  const trackedArgs = ["diff", "--binary", session.baseCommit, "--", ...(selected.length ? selected : ["."])];
  const patch = execFileSync("git", trackedArgs, { cwd: session.worktreePath, encoding: "buffer" });
  if (patch.length) execFileSync("git", ["apply", "--binary", "-"], { cwd: session.gitRoot, input: patch, stdio: ["pipe", "pipe", "pipe"] });

  const untracked = git(session.worktreePath, ["ls-files", "--others", "--exclude-standard", "--", ...(selected.length ? selected : ["."])])
    .split("\n").filter((file) => Boolean(file) && file !== METADATA_FILE).map(validateRelativeFile);
  for (const file of untracked) {
    const source = join(session.worktreePath, file);
    const target = join(session.gitRoot, file);
    assertRealPathInside(session.worktreePath, source, "Origem de promoção");
    assertRealPathInside(session.gitRoot, target, "Destino de promoção");
    mkdirSync(dirname(target), { recursive: true });
    assertRealPathInside(session.gitRoot, target, "Destino de promoção");
    cpSync(realpathSync(source), target, { recursive: true, force: true });
  }
  return [...(selected.length ? selected : ["alterações rastreadas"]), ...untracked];
}

/** Promove alterações rastreadas e arquivos untracked ao projeto original. */
export function promoteWorktreeChanges(session: SandboxSession, files: string[] = []): string[] {
  if (!session.gitRoot || !session.branchName) {
    throw new Error("[dev-sandbox] Promoção indisponível: o projeto não possui um worktree Git.");
  }
  return applyWorktreeChanges(session, files.map(validateRelativeFile));
}

/** Aplica alterações do worktree e registra snapshot para restauração posterior. */
export function promoteWorktreePreview(session: SandboxSession, files: string[] = []): string[] {
  if (!session.gitRoot || !session.branchName) {
    throw new Error("[dev-sandbox] Preview indisponível: o projeto não possui um worktree Git.");
  }
  const selected = files.map(validateRelativeFile);
  const changed = changedWorktreeFiles(session, selected);
  const state = previewStates.get(session.sessionId) ?? { files: new Map<string, PreviewFileState>() };
  const previous = [...state.files.keys()].filter((file) => selectedPath(file, selected));
  const reconcile = [...new Set([...previous, ...changed])];

  for (const file of reconcile) {
    const current = state.files.get(file);
    if (current && fileFingerprint(join(session.gitRoot, file)) !== current.promotedFingerprint) {
      throw new Error(`[dev-sandbox] Arquivo promovido foi alterado no projeto original: ${file}`);
    }
    if (!current) state.files.set(file, { snapshot: captureOriginalFile(session, file), promotedFingerprint: "" });
  }
  for (const file of previous) restoreSnapshot(session, file, state.files.get(file)!.snapshot);

  applyWorktreeChanges(session, selected);
  for (const file of previous) {
    if (!changed.includes(file)) state.files.delete(file);
  }
  for (const file of changed) {
    const entry = state.files.get(file) ?? { snapshot: captureOriginalFile(session, file), promotedFingerprint: "" };
    entry.promotedFingerprint = fileFingerprint(join(session.gitRoot, file));
    state.files.set(file, entry);
  }
  if (state.files.size) previewStates.set(session.sessionId, state);
  else previewStates.delete(session.sessionId);
  return changed;
}

/** Restaura snapshot do último preview e limpa seu estado. */
export function restoreWorktreePreview(session: SandboxSession): string[] {
  const state = previewStates.get(session.sessionId);
  if (!state) return [];
  const files = [...state.files.keys()];
  for (const file of files) {
    const entry = state.files.get(file)!;
    if (fileFingerprint(join(session.gitRoot, file)) !== entry.promotedFingerprint) {
      throw new Error(`[dev-sandbox] Arquivo promovido foi alterado no projeto original: ${file}`);
    }
  }
  for (const file of files) restoreSnapshot(session, file, state.files.get(file)!.snapshot);
  previewStates.delete(session.sessionId);
  return files;
}

export function isManagedWorktreePath(path: string, root = DEFAULT_WORKTREE_ROOT): boolean { return resolve(path).startsWith(resolve(root) + "/"); }
