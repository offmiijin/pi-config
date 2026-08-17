/** Estado da sessão isolada do dev-sandbox. */

/**
 * Identidade e caminhos da sessão atual.
 *
 * `originalCwd` é usado para configuração e operações administrativas do Git.
 * `workspaceCwd` é o único diretório que deve ser usado pelas tools.
 */
export interface SandboxSession {
  /** Identificador único da sessão. */
  sessionId: string;
  /** Diretório originalmente aberto pelo usuário. */
  originalCwd: string;
  /** Raiz do repositório Git original. */
  gitRoot: string;
  /** Diretório administrativo Git montado seletivamente no sandbox. */
  gitDir: string;
  /** Branch temporária associada à sessão. */
  branchName: string;
  /** Branch original usada como base da sessão. */
  originalBranchName: string;
  /** Raiz sob a qual worktrees temporários são criados. */
  worktreeRoot: string;
  /** Diretório do worktree temporário; normalmente igual a workspaceCwd. */
  worktreePath: string;
  /** Workspace efetivo usado pelas tools dentro do sandbox. */
  workspaceCwd: string;
  /** Momento de criação da sessão, em ISO 8601. */
  startedAt: string;
}

/** Retorna workspace efetivo ou lança se sessão não foi inicializada. */
export function requireWorkspace(session: SandboxSession | null): string {
  if (!session) {
    throw new Error("[dev-sandbox] Sessão de workspace não inicializada.");
  }
  return session.workspaceCwd;
}

/** Retorna diretório original ou lança se sessão não foi inicializada. */
export function requireOriginalCwd(session: SandboxSession | null): string {
  if (!session) {
    throw new Error("[dev-sandbox] Sessão de sandbox não inicializada.");
  }
  return session.originalCwd;
}
