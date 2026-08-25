/** Estado da sessão isolada do pi-sandbox. */

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
  /** Raiz do repositório Git original; vazio para projetos sem Git. */
  gitRoot: string;
  /** Diretório administrativo Git montado seletivamente no sandbox. */
  gitDir: string;
  /** Branch atualmente ativa no worktree. */
  branchName: string;
  /** Branch criada automaticamente pelo sandbox e que pode ser removida. */
  temporaryBranchName: string;
  /** Branch original usada como base da sessão. */
  originalBranchName: string;
  /** Commit usado como base para comparar alterações da sessão. */
  baseCommit: string;
  /** Raiz sob a qual worktrees temporários são criados. */
  worktreeRoot: string;
  /** Diretório do worktree temporário; no modo in-place é a raiz original. */
  worktreePath: string;
  /** Indica que o workspace usa diretamente a raiz original do projeto. */
  inPlace: boolean;
  /** Subdiretório do repositório originalmente aberto pelo usuário. */
  workspaceSubdir: string;
  /** Workspace efetivo usado pelas tools dentro do sandbox. */
  workspaceCwd: string;
  /** Momento de criação da sessão, em ISO 8601. */
  startedAt: string;
}

/** Retorna workspace efetivo ou lança se sessão não foi inicializada. */
export function requireWorkspace(session: SandboxSession | null): string {
  if (!session) {
    throw new Error("[pi-sandbox] Sessão de workspace não inicializada.");
  }
  return session.workspaceCwd;
}

/** Retorna diretório original ou lança se sessão não foi inicializada. */
export function requireOriginalCwd(session: SandboxSession | null): string {
  if (!session) {
    throw new Error("[pi-sandbox] Sessão de sandbox não inicializada.");
  }
  return session.originalCwd;
}
