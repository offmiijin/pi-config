/**
 * Extensão pi-sandbox — sandbox completo via bubblewrap.
 *
 * Isola todas as tools built-in do pi (read, write, edit, bash,
 * grep, find, ls) dentro de um namespace bwrap com:
 *   - Filesystem restrito (whitelist de /usr, /bin, /lib; /sbin vazio)
 *   - Rede do host compartilhada (para LLM API, npm, git)
 *   - HOME isolado (sem acesso ao home real)
 *   - SSH via ssh-agent socket (chaves privadas nunca entram)
 *
 * Complementa pi-hooks/security-guard.ts:
 *   - pi-sandbox    = hard boundary (kernel namespaces, capabilities, seccomp)
 *   - security-guard = soft boundary MÍNIMO — só o que o sandbox não isola
 *     (fork bomb, download+pipe a bash, eval dinâmico)
 *
 * Política (fail-closed):
 *   - Se o sandbox não puder ser ativado (bwrap ausente, erro de
 *     inicialização), as tools são BLOQUEADAS — nunca executam no host.
 *   - Fallback para tools do host apenas com opt-out explícito:
 *     `--no-sandbox` ou `enabled: false` na configuração.
 *   - `.pi/sandbox.json` (projeto) só é aplicado se o projeto for
 *     confiável (ctx.isProjectTrusted()).
 *
 * Integração:
 *   - Dev-sandbox registra tool unificado com bwrap operations
 *
 * Configuração:
 *   - ~/.pi/agent/extensions/pi-sandbox.json (global)
 *   - .pi/sandbox.json (projeto, somente se confiável)
 *
 * Uso:
 *   pi                          → sandbox ativo por padrão
 *   pi --no-sandbox             → desabilita sandbox (tools do host)
 *   /sandbox                    → abre as configurações interativas
 *   /sandbox info               → mostra informações da sessão
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getSettingsListTheme,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createFindTool,
  createLsTool,
  createGrepTool as createGrepToolSdk,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSandboxArgumentCompletions } from "./command-completions";
import {
  loadConfig,
  isBwrapAvailable,
  getBwrapInstallGuide,
  isRgAvailable,
  getRgInstallGuide,
  saveBooleanSetting,
  saveSetting,
  type SandboxConfigScope,
} from "./config";
import {
  resolveLandlockExecPath,
  resolveSeccompBpfPath,
  probeUserNamespaces,
  archTriplet,
} from "./portability";
import type { SandboxConfig } from "./types";
import {
  getSandboxBooleanSetting,
  getSandboxEnumSetting,
  SANDBOX_BOOLEAN_SETTINGS,
  SANDBOX_ENUM_SETTINGS,
  setSandboxBooleanSetting,
  setSandboxEnumSetting,
  type SandboxBooleanSettingKey,
  type SandboxEnumSettingKey,
} from "./sandbox-settings";
import type { SandboxSession } from "./session";
import {
  cleanupOrphanedWorktrees,
  cleanupWorktree,
  createWorktree,
  isGitRepository,
  promoteWorktreePreview,
  refreshWorktreeBranch,
  restoreWorktreePreview,
  WorktreeBranchUnavailableError,
} from "./worktree";
import { createBashOps } from "./tools/bash-ops";
import { resolveCacheDirs, probeLandlockAbi, setLandlockExecPath, ensureQuarantineDir, resolveQuarantineDirs, execInSandbox } from "./bwrap-executor";
import { execQuarantine, fetchUrl, promoteArtifact } from "./quarantine";
import { dependencyBootstrapHint } from "./dependency-bootstrap";
import { createNpmInstallPlan } from "./dependency-install";
import { Type } from "typebox";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { createReadOps } from "./tools/read-ops";
import { createWriteOps } from "./tools/write-ops";
import { createEditOps } from "./tools/edit-ops";
import { createFindOps } from "./tools/find-ops";
import { createLsOps } from "./tools/ls-ops";
import { createGrepTool } from "./tools/grep";
import { compactBashToolResult, compactBashToolError } from "./tools/bash-output";

/** Diretório desta extensão — usado para resolver seccomp.bpf. */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const SANDBOX_STATE_ENTRY = "dev-sandbox-state";

interface PersistedSandboxState {
  version: 1;
  branchName: string;
}

function readPersistedSandboxState(ctx: any): PersistedSandboxState | null {
  try {
    const manager = ctx.sessionManager;
    const entries = typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : [...(manager?.getEntries?.() ?? [])].reverse();
    const entry = entries.find((candidate: any) =>
      candidate?.type === "custom" && candidate.customType === SANDBOX_STATE_ENTRY,
    );
    const data = entry?.data;
    if (data?.version !== 1 || typeof data.branchName !== "string" || !data.branchName.trim()) return null;
    return { version: 1, branchName: data.branchName.trim() };
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  // ── Flag --no-sandbox ──────────────────────────
  pi.registerFlag("no-sandbox", {
    description: "Desabilita o sandbox de desenvolvimento",
    type: "boolean",
    default: false,
  });

  // ── Estado da sessão ───────────────────────────
  let config: SandboxConfig | null = null;
  let enabled = false;
  /** true com opt-out explícito (--no-sandbox ou enabled:false) → tools do host. */
  let fallbackToHost = false;
  let projectTrusted = false;
  let localCwd = process.cwd();
  let originalCwd = process.cwd();
  let session: SandboxSession | null = null;
  let persistedBranchName = "";
  let restoreWarning = "";

  function emitSessionState(): void {
    if (!session) return;
    pi.events?.emit("custom:dev-sandbox-session", {
      originalCwd: session.originalCwd,
      workspaceCwd: session.workspaceCwd,
      worktreePath: session.worktreePath,
      baseCommit: session.baseCommit,
      branchName: session.branchName,
      originalBranchName: session.originalBranchName,
      inPlace: session.inPlace,
    });
  }

  function persistActiveBranch(): void {
    if (!session?.gitRoot || session.inPlace || !session.branchName || session.branchName === session.temporaryBranchName) return;
    if (session.branchName === persistedBranchName) return;
    try {
      pi.appendEntry(SANDBOX_STATE_ENTRY, { version: 1, branchName: session.branchName });
      persistedBranchName = session.branchName;
    } catch (err) {
      console.warn("[pi-sandbox] Não foi possível persistir a branch da sessão:", err);
    }
  }

  function refreshBranchState(): void {
    if (!session?.gitRoot) return;
    try {
      if (refreshWorktreeBranch(session)) {
        emitSessionState();
        persistActiveBranch();
      }
    } catch (err) {
      console.warn("[pi-sandbox] Não foi possível atualizar a branch do worktree:", err);
    }
  }

  function releaseSession(): void {
    const current = session;
    session = null;
    if (!current) return;
    try {
      if (config?.worktree.cleanup !== "never") cleanupWorktree(current);
    } catch (err) {
      console.error("[pi-sandbox] Falha ao remover worktree temporário:", err);
    }
  }

  // ── session_start ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    originalCwd = ctx.cwd;
    localCwd = ctx.cwd;
    enabled = false;
    config = null;
    session = null;
    persistedBranchName = "";
    restoreWarning = "";
    fallbackToHost = false;
    projectTrusted = ctx.isProjectTrusted?.() ?? false;

    // --no-sandbox: opt-out explícito → tools do host
    if (pi.getFlag("no-sandbox") as boolean) {
      fallbackToHost = true;
      if (ctx.hasUI) {
        ctx.ui.notify("Sandbox desabilitado via --no-sandbox", "warning");
      }
      return;
    }

    try {
      // Config do projeto só é aplicada se o projeto for confiável
      config = loadConfig(originalCwd, { projectTrusted: ctx.isProjectTrusted?.() ?? false });

      // enabled: false na configuração = opt-out explícito → tools do host
      if (!config.enabled) {
        fallbackToHost = true;
        if (ctx.hasUI) {
          ctx.ui.notify("Sandbox desabilitado na configuração. Tools rodam sem isolamento.", "info");
        }
        return;
      }

      // bwrap ausente → fail-closed (tools bloqueadas, nunca host)
      if (!isBwrapAvailable()) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `bubblewrap não encontrado. Tools sandbox desativadas (fail-closed).\nInstalação: ${getBwrapInstallGuide()}`,
            "error",
          );
        }
        return;
      }

      // ripgrep ausente → warning não-bloqueante
      if (!isRgAvailable() && ctx.hasUI) {
        ctx.ui.notify(
          `⚠️ ripgrep não encontrado. Tool grep pode operar em modo degradado.\nInstalação: ${getRgInstallGuide()}`,
          "warning",
        );
      }

      // User namespaces — bwrap depende deles; aviso não-bloqueante
      // (se falhar de verdade, o bwrap falha e as tools ficam fail-closed).
      if (!probeUserNamespaces() && ctx.hasUI) {
        ctx.ui.notify(
          "⚠️ User namespaces parecem indisponíveis — bwrap pode falhar ao iniciar.\n" +
          "Verifique kernel.unprivileged_userns_clone=1 (sysctl) ou o AppArmor do container.",
          "warning",
        );
      }

      // ── Worktree temporário ───────────────────
      const inPlace = config.worktree.mode === "in-place";
      if (!inPlace && !config.worktree.enabled && isGitRepository(originalCwd)) {
        throw new Error("[pi-sandbox] Worktree temporário desabilitado na configuração.");
      }
      const persistedState = inPlace ? null : readPersistedSandboxState(ctx);
      persistedBranchName = persistedState?.branchName ?? "";
      try {
        session = createWorktree(originalCwd, config.worktree.root, {
          mode: config.worktree.mode,
          restoreBranch: persistedState?.branchName,
        });
      } catch (err) {
        if (!(err instanceof WorktreeBranchUnavailableError) || err.reason !== "missing") throw err;
        session = createWorktree(originalCwd, config.worktree.root);
        restoreWarning =
          `A branch persistida '${err.branchName}' não existe mais. ` +
          `Novo sandbox criado em '${session.branchName}' a partir da branch original atual.`;
      }
      if (session.gitRoot && !session.inPlace) cleanupOrphanedWorktrees(config.worktree.root, session.gitRoot);
      localCwd = session.workspaceCwd;
      emitSessionState();

      // Git precisa dos metadados para status/branch/commit/push, mas o código
      // do projeto original continua fora do namespace. Projetos sem Git usam
      // a própria raiz como workspace e não precisam desse mount adicional.
      if (session.gitDir && !config.filesystem.extraWritable.includes(session.gitDir)) {
        config.filesystem.extraWritable.push(session.gitDir);
      }

      // npm/pip permanecem persistentes no projeto original; clones, fetch e
      // runs são específicos desta sessão e ficam no worktree. O projeto
      // original continua inacessível, salvo pelos caches persistentes
      // montados individualmente.
      const originalCaches = resolveCacheDirs(config, originalCwd);
      const worktreeCaches = resolveCacheDirs(config, localCwd);
      const sessionCaches = { ...originalCaches, clones: worktreeCaches.clones };
      const sessionQuarantine = resolveQuarantineDirs(config, localCwd);
      config.filesystem.cacheDirs = sessionCaches as unknown as typeof config.filesystem.cacheDirs;
      config.filesystem.quarantineDirs = sessionQuarantine;

      // ── Seccomp BPF ───────────────────────────
      // Seleciona por arquitetura: seccomp-<arch>.bpf → seccomp.bpf (universal,
      // cobre x86_64 + aarch64 + riscv64 num único filtro).
      if (!config.seccomp.bpfPath) {
        config.seccomp.bpfPath =
          resolveSeccompBpfPath(EXT_DIR) ?? join(EXT_DIR, "seccomp.bpf");
      }
      if (config.seccomp.enabled && !existsSync(config.seccomp.bpfPath)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Filtro seccomp não encontrado em ${config.seccomp.bpfPath}.\n` +
            "Execute 'gen-seccomp > seccomp.bpf' na extensão para gerar.\n" +
            "Sandbox continuará sem seccomp (modo degradado).",
            "warning",
          );
        }
        config.seccomp.enabled = false;
      }

      // ── Landlock ────────────────────────────
      // Landlock é a 4ª camada de defesa (após namespaces, capabilities, seccomp).
      // Quando required=true, helper/ABI ausente bloqueia a sessão (fail-closed).
      if (config.landlock.enabled) {
        // Helper da arquitetura atual (landlock-exec-<arch> → landlock-exec → target/release)
        const hostPath = resolveLandlockExecPath(EXT_DIR);
        if (!hostPath) {
          const msg =
            `Landlock helper não encontrado (procurado: landlock-exec-${archTriplet()} em ${EXT_DIR}).\n` +
            "Landlock desabilitado — sandbox opera com namespaces + capabilities + seccomp.\n" +
            "Compile com: cd extensions/pi-sandbox/gen-seccomp && ./build.sh";
          if (config.landlock.required) {
            throw new Error(msg);
          }
          if (ctx.hasUI) ctx.ui.notify(msg, "warning");
          console.warn("[pi-sandbox] landlock-exec não encontrado — Landlock desabilitado.");
          config.landlock.enabled = false;
        } else {
          const abi = probeLandlockAbi(hostPath);
          if (abi === null || abi < config.landlock.minAbi) {
            const msg =
              `Landlock requer ABI >= ${config.landlock.minAbi}, ` +
              `detectada: ${abi ?? "indisponível"}. Landlock desabilitado.`;
            if (config.landlock.required) {
              throw new Error(msg);
            }
            if (ctx.hasUI) ctx.ui.notify(msg, "warning");
            console.warn(
              `[pi-sandbox] Landlock ABI insuficiente (${abi ?? "N/A"} < ${config.landlock.minAbi}) — modo degradado.`
            );
            config.landlock.enabled = false;
          } else {
            // Helper disponível e ABI compatível — registra para montagem
            setLandlockExecPath(hostPath);
          }
        }
      }

      enabled = true;

      // Diretórios de quarentena (fetch/runs) — criados com 0o700
      // dentro do worktree da sessão.
      const qdirs = config.filesystem.quarantineDirs;
      ensureQuarantineDir(qdirs.fetch);
      ensureQuarantineDir(qdirs.runs);

      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "sandbox",
          `[🔒 Sandbox ativo] ${localCwd}`,
        );
        ctx.ui.notify(
          `Sandbox inicializado.\nWorkspace: ${localCwd}\nRede: ${config.internet.enabled ? "compartilhada" : "isolada"}\n` +
          `Quarentena: fetch=${qdirs.fetch}\nruns=${qdirs.runs}`,
          "info",
        );
        if (restoreWarning) ctx.ui.notify(restoreWarning, "warning");
      }
    } catch (err: any) {
      // Erro inesperado → fail-closed: nunca roda sem sandbox silenciosamente
      enabled = false;
      releaseSession();
      config = null;
      console.error("[pi-sandbox] Falha ao inicializar sandbox:", err);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Falha ao inicializar sandbox. Tools bloqueadas.\n${err?.message ?? String(err)}`,
          "error",
        );
      }
    }
  });

  /** Erro lançado pelas tools quando o sandbox não está ativo (fail-closed). */
  function sandboxBlockedError(toolName: string): Error {
    return new Error(
      `[pi-sandbox] Tool '${toolName}' bloqueada: sandbox não está ativo. ` +
      "Instale bubblewrap e habilite o sandbox, ou use --no-sandbox para rodar sem isolamento.",
    );
  }

  /**
   * Cria wrapper sandboxed de uma tool built-in.
   * - Schema/descrição vêm da tool original (makeTool).
   * - Sandbox ativo → makeSandboxed (ops via bwrap).
   * - Opt-out explícito (--no-sandbox / enabled:false) → makeTool (host).
   * - Fail-closed → erro sandboxBlockedError.
   */
  function sandboxTool<TTool extends ToolDefinition<any, any, any>>(
    makeTool: (cwd: string) => TTool,
    makeSandboxed: (config: SandboxConfig, cwd: string, workspaceRoot: string) => TTool,
    label?: string,
    postProcess?: (result: unknown, params: unknown) => unknown,
    processError?: (error: unknown, params: unknown) => unknown,
  ): TTool {
    const base = makeTool(localCwd);
    return {
      ...base,
      ...(label !== undefined ? { label } : {}),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cwd = session?.workspaceCwd ?? ctx.cwd ?? localCwd;
        const execute = async () => {
          if (!enabled || !config) {
            if (fallbackToHost) return makeTool(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
            throw sandboxBlockedError(base.name);
          }
          const workspaceRoot = session?.worktreePath ?? cwd;
          return makeSandboxed(config, cwd, workspaceRoot).execute(toolCallId, params, signal, onUpdate, ctx);
        };
        try {
          const result = await execute();
          return postProcess ? postProcess(result, params) : result;
        } catch (error) {
          if (processError) throw processError(error, params);
          throw error;
        }
      },
    };
  }

  // ── Substitui todas as tools ───────────────────

  pi.registerTool(sandboxTool(
    (cwd) => createReadTool(cwd),
    (config, cwd, workspaceRoot) => createReadTool(cwd, { operations: createReadOps(config, cwd, workspaceRoot) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createWriteTool(cwd),
    (config, cwd, workspaceRoot) => createWriteTool(cwd, { operations: createWriteOps(config, cwd, workspaceRoot) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createEditTool(cwd),
    (config, cwd, workspaceRoot) => createEditTool(cwd, { operations: createEditOps(config, cwd, workspaceRoot) }),
  ));

  // ── Bash tool unificado com bwrap operations ──
  pi.registerTool(sandboxTool(
    (cwd) => createBashTool(cwd),
    (config, cwd, workspaceRoot) => createBashTool(cwd, { operations: createBashOps(config, cwd, workspaceRoot, refreshBranchState) }),
    "bash (sandboxed)",
    (result, params) => compactBashToolResult(result, params),
    (error, params) => compactBashToolError(error, params),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createFindTool(cwd),
    (config, cwd, workspaceRoot) => createFindTool(cwd, { operations: createFindOps(config, cwd, workspaceRoot) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createLsTool(cwd),
    (config, cwd, workspaceRoot) => createLsTool(cwd, { operations: createLsOps(config, cwd, workspaceRoot) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createGrepToolSdk(cwd),
    (config, cwd, workspaceRoot) => createGrepTool(cwd, config, workspaceRoot),
  ));

  // ── Instalação segura de dependências ─────────
  pi.registerTool({
    name: "sandbox_install_dependencies",
    label: "Sandbox Install Dependencies",
    description:
      "Installs npm dependencies in the current trusted sandbox workspace. " +
      "Uses npm ci/install with --ignore-scripts and persistent npm cache. " +
      "Does not accept arbitrary commands or run lifecycle scripts.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      if (!enabled || !config) throw sandboxBlockedError("sandbox_install_dependencies");
      if (!projectTrusted) {
        throw new Error("[pi-sandbox] sandbox_install_dependencies exige projeto confiável.");
      }

      const cwd = session?.workspaceCwd ?? ctx.cwd ?? localCwd;
      const plan = createNpmInstallPlan(cwd);
      const result = await execInSandbox(
        config,
        { command: plan.command, cwd, workspaceRoot: session?.worktreePath, timeout: 900, signal },
        "normal",
      );
      const output = [result.stdout.toString(), result.stderr].filter(Boolean).join("\n");
      const text = [output, `exit code: ${result.exitCode}`].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: {
          exitCode: result.exitCode,
          cwd,
          command: plan.command,
          lockfile: plan.lockfile,
          cache: resolveCacheDirs(config, originalCwd).npm,
        },
      };
    },
  });

  // ── Tools de quarentena ──────────────────────
  // Exigem sandbox ativo: sem isolamento não há como baixar/executar
  // código externo com segurança (fail-closed, mesmo com --no-sandbox).
  function quarantineBlockedError(toolName: string): Error {
    return new Error(
      `[pi-sandbox] Tool '${toolName}' exige sandbox ativo. ` +
      "Sem isolamento, download/execução de código externo não é permitido.",
    );
  }

  pi.registerTool({
    name: "sandbox_fetch",
    label: "Sandbox Fetch",
    description:
      "Downloads external content (http/https) into an isolated quarantine directory " +
      "with NO access to the project workspace. Use before executing downloaded code. " +
      "Returns the absolute path of the downloaded file.",
    parameters: Type.Object({
      url: Type.String({ description: "http/https URL to download" }),
      output: Type.Optional(Type.String({
        description: "File name or relative path inside the fetch directory (default: URL basename)",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!enabled || !config) throw quarantineBlockedError("sandbox_fetch");
      const cwd = session?.workspaceCwd ?? ctx.cwd ?? localCwd;
      const { file, result } = await fetchUrl(config, cwd, params.url, params.output, signal);
      if (result.exitCode !== 0) {
        throw new Error(
          `[pi-sandbox] sandbox_fetch falhou (exit ${result.exitCode}).\n${result.stderr || "sem stderr"}`,
        );
      }
      return {
        content: [{ type: "text", text: `Downloaded: ${file}` }],
        details: { file, exitCode: result.exitCode },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_quarantine_exec",
    label: "Sandbox Quarantine Exec",
    description:
      "Runs a shell command in full isolation: NO network and NO access to the project workspace. " +
      "Works in .sandbox-cache/runs/<workDir> (persists between calls). Optionally copies artifacts " +
      "from the fetch directory (sandbox_fetch) into the work dir before running. " +
      "Use to install (npm/pip), run tests, or execute downloaded code safely. " +
      "For empty package caches, use sandbox_fetch and pass downloaded wheels/tarballs via artifacts. " +
      "The exit code is returned in details; non-zero exit does not throw — inspect the output.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run (bash -lc)" }),
      workDir: Type.Optional(Type.String({
        description: "Work subdirectory under .sandbox-cache/runs (default: 'default')",
      })),
      artifacts: Type.Optional(Type.Array(Type.String({
        description: "Relative paths in the fetch directory to copy into the work dir before executing",
      }))),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!enabled || !config) throw quarantineBlockedError("sandbox_quarantine_exec");
      const cwd = session?.workspaceCwd ?? ctx.cwd ?? localCwd;
      const result = await execQuarantine(
        config, cwd, params.command, params.workDir ?? "default", params.artifacts ?? [], signal,
      );
      const out = result.stdout.toString();
      const err = result.stderr;
      const output = [out, err].filter(Boolean).join("\n");
      const bootstrapHint = dependencyBootstrapHint(params.command, output);
      const text = [output, bootstrapHint, `exit code: ${result.exitCode}`].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          bootstrapHint: Boolean(bootstrapHint),
        },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_promote",
    label: "Sandbox Promote",
    description:
      "Copies an artifact produced in quarantine (.sandbox-cache/runs) back into the project workspace. " +
      "Explicit action — the only way out of quarantine into the project.",
    parameters: Type.Object({
      source: Type.String({
        description: "Path inside the runs directory (e.g. 'default/dist/app.js')",
      }),
      target: Type.String({
        description: "Relative workspace path to copy to (e.g. 'dist/app.js')",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!enabled || !config) throw quarantineBlockedError("sandbox_promote");
      const target = await promoteArtifact(config, localCwd, params.source, params.target);
      return {
        content: [{ type: "text", text: `Promoted: ${target}` }],
        details: { target },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_promote_preview",
    label: "Sandbox Promote Preview",
    description: "Promotes temporary worktree changes to the original project for live preview. Saves a snapshot for restore.",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String({ description: "Relative file paths; omit to preview all changes" }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!enabled || !config || !session) throw quarantineBlockedError("sandbox_promote_preview");
      const files = promoteWorktreePreview(session, params.files ?? []);
      return { content: [{ type: "text", text: `Preview promoted: ${files.join(", ")}` }], details: { files } };
    },
  });

  pi.registerTool({
    name: "sandbox_promote_restore",
    label: "Sandbox Promote Restore",
    description: "Restores original project files changed by the latest sandbox preview. Refuses external modifications.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!enabled || !config || !session) throw quarantineBlockedError("sandbox_promote_restore");
      const files = restoreWorktreePreview(session);
      return { content: [{ type: "text", text: `Preview restored: ${files.join(", ") || "nothing"}` }], details: { files } };
    },
  });

  // ── user_bash (!comando e !!comando) ──────────
  pi.on("user_bash", (_event, ctx) => {
    const cwd = session?.workspaceCwd ?? ctx?.cwd ?? localCwd;
    if (enabled && config) {
      return { operations: createBashOps(config, cwd, session?.worktreePath ?? cwd, refreshBranchState) };
    }
    // Opt-out explícito → comportamento padrão do pi
    if (fallbackToHost) return;
    // Fail-closed: bloqueia com mensagem clara
    return {
      result: {
        output:
          "[pi-sandbox] Comando bloqueado: sandbox não está ativo. " +
          "Instale bubblewrap e habilite o sandbox, ou use --no-sandbox.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  // ── before_agent_start ────────────────────────
  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled || !config) return;
    const cwd = session?.workspaceCwd ?? ctx?.cwd ?? localCwd;
    const caches = resolveCacheDirs(config, cwd);
    const sandboxNote =
      `Current working directory: ${cwd} (sandboxed — bubblewrap namespaces)\n` +
      `Active Git branch: ${session?.branchName || "detached HEAD"}.\n` +
      `Git workspace mode: ${session?.inPlace ? "in-place (commits update the checked-out reference branch)" : "temporary worktree (commits stay on the sandbox branch)"}.\n` +
      (restoreWarning ? `Warning: ${restoreWarning}\n` : "") +
      `Persistent dirs (survive between commands): npm cache ${caches.npm}, pip cache ${caches.pip}. ` +
      `Clone remote repos for this session in ${caches.clones}. /tmp is ephemeral — data written there is lost.`;
    const dependencyNote = existsSync(join(cwd, "package.json")) && !existsSync(join(cwd, "node_modules"))
      ? "\npackage.json encontrado sem node_modules — use sandbox_install_dependencies."
      : "";
    const landlockNote = config.landlock.enabled
      ? "\nLandlock filesystem allowlist active."
      : "";
    const quarantineNote =
      "\nInstalling or executing external code (npm install, pip install, curl|bash) is BLOCKED in bash. " +
      "Download/run external code through the quarantine profiles:\n" +
      "- sandbox_fetch: download a file/URL (network ON, NO access to the project).\n" +
      "- sandbox_install_dependencies: install npm dependencies in the trusted sandbox workspace with --ignore-scripts.\n" +
      "- sandbox_quarantine_exec: install (npm/pip) or run downloaded code (NO network, NO project " +
      "access, writes only under .sandbox-cache/runs/<work> and configured caches).\n" +
      "- sandbox_promote: copy ONE specific artifact from runs/ back into the project — explicit, " +
      "the only way out.\n" +
      "Use normal bash only for project work.";
    return { systemPrompt: `${event.systemPrompt}\n\n${sandboxNote}${dependencyNote}${landlockNote}${quarantineNote}` };
  });

  function showSandboxInfo(ctx: any): void {
    if (!enabled || !config) {
      ctx.ui.notify(
        "Sandbox desabilitado.\nUse '--no-sandbox' ou verifique a instalação do bubblewrap.",
        "info",
      );
      return;
    }

    const caches = resolveCacheDirs(config, localCwd);
    const qdirs = resolveQuarantineDirs(config, localCwd);
    const prof = config.profiles;
    const lines = [
      `🔒 Sandbox de Desenvolvimento`,
      ``,
      `Status: ativo`,
      `Workspace: ${localCwd}`,
      `Worktree: ${session?.gitRoot ? session.worktreePath : "não aplicável (projeto sem Git)"}`,
      `Branch: ${session?.branchName || "detached HEAD"}`,
      `Workspace Git: ${session?.inPlace ? "in-place (raiz original)" : "worktree temporário"}`,
      `Worktree cleanup: ${config.worktree.cleanup}`,
      `Rede: ${config.internet.enabled ? "compartilhada com host" : "isolada"}`,
      `SSH: ${config.ssh.mode === "agent" ? "ssh-agent socket" : config.ssh.mode === "mount" ? "~/.ssh montado read-only" : "não montado"}`,
      `Landlock: ${config.landlock.enabled ? "ativo (ABI min: " + config.landlock.minAbi + ")" : "desabilitado"}`,
      `Seccomp: ${config.seccomp.enabled ? "ativo (" + config.seccomp.bpfPath + ")" : "desabilitado"}`,
      `Capabilities: ${config.capabilities.drop.length} droppadas`,
      `Perfis: normal=${prof.normal.enabled ? "ok" : "off"} | fetch=${prof.fetch.enabled ? "ok" : "off"} | quarantine=${prof.quarantine.enabled ? "ok" : "off"}`,
      `Quarentena: fetch=${qdirs.fetch} | runs=${qdirs.runs}`,
      `Caches: npm=${caches.npm} | pip=${caches.pip}`,
      `Clones: ${caches.clones}`,
    ];

    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function showSandboxSettings(ctx: any): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("As configurações do sandbox exigem uma sessão interativa.", "warning");
      return;
    }

    const scopes: Array<{ value: SandboxConfigScope; label: string }> = [
      { value: "global", label: "Global (~/.pi/agent/extensions/pi-sandbox.json)" },
    ];
    if (projectTrusted) scopes.push({ value: "project", label: "Projeto (.pi/sandbox.json)" });

    const selectedScope = await ctx.ui.select("Escopo da configuração do sandbox", scopes.map((scope) => scope.label));
    if (!selectedScope) return;
    const scope = scopes.find((candidate) => candidate.label === selectedScope)?.value;
    if (!scope) return;

    const settingsConfig = config ?? loadConfig(originalCwd, { projectTrusted });
    const items: SettingItem[] = [
      ...SANDBOX_BOOLEAN_SETTINGS.map((setting) => ({
        id: setting.key,
        label: setting.label,
        description: setting.description,
        currentValue: getSandboxBooleanSetting(settingsConfig, setting.key) ? "true" : "false",
        values: ["true", "false"],
      })),
      ...SANDBOX_ENUM_SETTINGS.map((setting) => ({
        id: setting.key,
        label: setting.label,
        description: setting.description,
        currentValue: getSandboxEnumSetting(settingsConfig, setting.key),
        values: [...setting.values],
      })),
    ];

    await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Configuração do sandbox")), 1, 1));
      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id: string, newValue: string) => {
          const booleanSetting = SANDBOX_BOOLEAN_SETTINGS.find((candidate) => candidate.key === id);
          const enumSetting = SANDBOX_ENUM_SETTINGS.find((candidate) => candidate.key === id);
          if (!booleanSetting && !enumSetting) return;
          try {
            const filePath = booleanSetting
              ? saveBooleanSetting(
                originalCwd,
                booleanSetting.key as SandboxBooleanSettingKey,
                newValue === "true",
                scope,
              )
              : saveSetting(originalCwd, enumSetting!.key as SandboxEnumSettingKey, newValue, scope);
            if (config) {
              if (booleanSetting) setSandboxBooleanSetting(config, booleanSetting.key, newValue === "true");
              else setSandboxEnumSetting(config, enumSetting!.key, newValue);
            }
            const label = booleanSetting?.label ?? enumSetting!.label;
            const restart = booleanSetting?.key === "enabled" || enumSetting?.key === "worktree.mode"
              ? " Reinicie a sessão para aplicar."
              : "";
            ctx.ui.notify(`${label}: ${newValue}. Salvo em ${filePath}.${restart}`, "info");
          } catch (error) {
            ctx.ui.notify(
              `Falha ao salvar configuração: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        },
        () => done(),
        { enableSearch: true },
      );
      container.addChild(settingsList);
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          settingsList.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  }

  // ── /sandbox command ──────────────────────────
  pi.registerCommand("sandbox", {
    description: "Configura o sandbox; use /sandbox info para informações da sessão",
    getArgumentCompletions: getSandboxArgumentCompletions,
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "info") {
        showSandboxInfo(ctx);
        return;
      }
      if (command === "") {
        await showSandboxSettings(ctx);
        return;
      }
      ctx.ui.notify("Uso: /sandbox ou /sandbox info", "warning");
    },
  });

  pi.registerCommand("promote-preview", {
    description: "Promove alterações do worktree para preview no projeto original",
    handler: async (_args, ctx) => {
      if (!enabled || !config || !session) {
        ctx.ui.notify("Preview indisponível: sandbox ou sessão não está ativo.", "error");
        return;
      }
      try {
        const files = promoteWorktreePreview(session);
        ctx.ui.notify(`Preview promovido: ${files.join(", ") || "nenhuma alteração"}`, "info");
      } catch (error) {
        ctx.ui.notify(`Falha ao promover preview: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("promote-restore", {
    description: "Restaura alterações aplicadas pelo último preview",
    handler: async (_args, ctx) => {
      if (!enabled || !config || !session) {
        ctx.ui.notify("Restore indisponível: sandbox ou sessão não está ativo.", "error");
        return;
      }
      try {
        const files = restoreWorktreePreview(session);
        ctx.ui.notify(`Preview restaurado: ${files.join(", ") || "nada para restaurar"}`, "info");
      } catch (error) {
        ctx.ui.notify(`Falha ao restaurar preview: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // ── session_shutdown ──────────────────────────
  pi.on("session_shutdown", () => {
    refreshBranchState();
    persistActiveBranch();
    pi.events?.emit("custom:dev-sandbox-session-shutdown", {});
    enabled = false;
    projectTrusted = false;
    releaseSession();
    config = null;
    localCwd = originalCwd;
    fallbackToHost = false;
  });
}
