/**
 * Extensão dev-sandbox — sandbox completo via bubblewrap.
 *
 * Isola todas as tools built-in do pi (read, write, edit, bash,
 * grep, find, ls) dentro de um namespace bwrap com:
 *   - Filesystem restrito (whitelist de /usr, /bin, /lib; /sbin vazio)
 *   - Rede do host compartilhada (para LLM API, npm, git)
 *   - HOME isolado (sem acesso ao home real)
 *   - SSH via ssh-agent socket (chaves privadas nunca entram)
 *
 * Complementa hooks/security-guard.ts:
 *   - dev-sandbox    = hard boundary (kernel namespaces, capabilities, seccomp)
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
 *   - ~/.pi/agent/extensions/dev-sandbox.json (global)
 *   - .pi/sandbox.json (projeto, somente se confiável)
 *
 * Uso:
 *   pi                          → sandbox ativo por padrão
 *   pi --no-sandbox             → desabilita sandbox (tools do host)
 *   /sandbox                    → mostra status e configuração
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
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
import { loadConfig, isBwrapAvailable, getBwrapInstallGuide, isRgAvailable, getRgInstallGuide } from "./config";
import {
  resolveLandlockExecPath,
  resolveSeccompBpfPath,
  probeUserNamespaces,
  archTriplet,
} from "./portability";
import type { SandboxConfig } from "./types";
import type { SandboxSession } from "./session";
import { cleanupOrphanedWorktrees, cleanupWorktree, createWorktree, promoteWorktreeChanges } from "./worktree";
import { createBashOps } from "./tools/bash-ops";
import { resolveCacheDirs, probeLandlockAbi, setLandlockExecPath, ensureQuarantineDir, resolveQuarantineDirs } from "./bwrap-executor";
import { execQuarantine, fetchUrl, promoteArtifact } from "./quarantine";
import { cleanupSandboxCaches } from "./cache-cleanup";
import { Type } from "typebox";
import { createReadOps } from "./tools/read-ops";
import { createWriteOps } from "./tools/write-ops";
import { createEditOps } from "./tools/edit-ops";
import { createFindOps } from "./tools/find-ops";
import { createLsOps } from "./tools/ls-ops";
import { createGrepTool } from "./tools/grep";

/** Diretório desta extensão — usado para resolver seccomp.bpf. */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

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
  let localCwd = process.cwd();
  let originalCwd = process.cwd();
  let session: SandboxSession | null = null;

  function releaseSession(): void {
    const current = session;
    session = null;
    if (!current) return;
    try {
      if (config?.worktree.cleanup !== "never") cleanupWorktree(current);
    } catch (err) {
      console.error("[dev-sandbox] Falha ao remover worktree temporário:", err);
    }
  }

  // ── session_start ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    originalCwd = ctx.cwd;
    localCwd = ctx.cwd;
    enabled = false;
    config = null;
    session = null;
    fallbackToHost = false;

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
      if (!config.worktree.enabled) {
        throw new Error("[dev-sandbox] Worktree temporário desabilitado na configuração.");
      }
      session = createWorktree(originalCwd, config.worktree.root);
      cleanupOrphanedWorktrees(config.worktree.root, session.gitRoot);
      localCwd = session.workspaceCwd;
      pi.events?.emit("custom:dev-sandbox-session", {
        originalCwd: session.originalCwd,
        branchName: session.branchName,
        originalBranchName: session.originalBranchName,
      });

      // Git precisa dos metadados para status/branch/commit/push, mas o código
      // do projeto original continua fora do namespace.
      if (!config.filesystem.extraWritable.includes(session.gitDir)) {
        config.filesystem.extraWritable.push(session.gitDir);
      }

      // Caches/quarentena persistem no projeto original, mas são montados
      // individualmente; o restante do projeto original continua inacessível.
      const persistentCaches = resolveCacheDirs(config, originalCwd);
      const persistentQuarantine = resolveQuarantineDirs(config, originalCwd);
      config.filesystem.cacheDirs = persistentCaches as unknown as typeof config.filesystem.cacheDirs;
      config.filesystem.quarantineDirs = persistentQuarantine;
      const cleanup = cleanupSandboxCaches(persistentCaches, persistentQuarantine);
      if (cleanup.removed > 0) {
        console.info(`[dev-sandbox] Limpeza de caches: ${cleanup.removed} entrada(s) removida(s).`);
      }

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
      // Se o helper não existir ou o kernel não suportar, opera em modo degradado
      // com aviso — NUNCA bloqueia o sandbox (as outras 3 camadas já protegem).
      if (config.landlock.enabled) {
        // Helper da arquitetura atual (landlock-exec-<arch> → landlock-exec → target/release)
        const hostPath = resolveLandlockExecPath(EXT_DIR);
        if (!hostPath) {
          const msg =
            `Landlock helper não encontrado (procurado: landlock-exec-${archTriplet()} em ${EXT_DIR}).\n` +
            "Landlock desabilitado — sandbox opera com namespaces + capabilities + seccomp.\n" +
            "Compile com: cd extensions/dev-sandbox/gen-seccomp && ./build.sh";
          if (config.landlock.required && ctx.hasUI) {
            ctx.ui.notify(msg, "warning");
          }
          console.warn("[dev-sandbox] landlock-exec não encontrado — Landlock desabilitado.");
          config.landlock.enabled = false;
          config.landlock.required = false;
        } else {
          const abi = probeLandlockAbi(hostPath);
          if (abi === null || abi < config.landlock.minAbi) {
            const msg =
              `Landlock requer ABI >= ${config.landlock.minAbi}, ` +
              `detectada: ${abi ?? "indisponível"}. Landlock desabilitado.`;
            if (config.landlock.required && ctx.hasUI) {
              ctx.ui.notify(msg, "warning");
            }
            console.warn(
              `[dev-sandbox] Landlock ABI insuficiente (${abi ?? "N/A"} < ${config.landlock.minAbi}) — modo degradado.`
            );
            config.landlock.enabled = false;
            config.landlock.required = false;
          } else {
            // Helper disponível e ABI compatível — registra para montagem
            setLandlockExecPath(hostPath);
          }
        }
      }

      enabled = true;

      // Diretórios de quarentena (fetch/runs) — criados com 0o700.
      const qdirs = resolveQuarantineDirs(config, localCwd);
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
      }
    } catch (err: any) {
      // Erro inesperado → fail-closed: nunca roda sem sandbox silenciosamente
      enabled = false;
      releaseSession();
      config = null;
      console.error("[dev-sandbox] Falha ao inicializar sandbox:", err);
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
      `[dev-sandbox] Tool '${toolName}' bloqueada: sandbox não está ativo. ` +
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
    makeSandboxed: (config: SandboxConfig, cwd: string) => TTool,
    label?: string,
  ): TTool {
    const base = makeTool(localCwd);
    return {
      ...base,
      ...(label !== undefined ? { label } : {}),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cwd = session?.workspaceCwd ?? ctx.cwd ?? localCwd;
        if (!enabled || !config) {
          if (fallbackToHost) return makeTool(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
          throw sandboxBlockedError(base.name);
        }
        return makeSandboxed(config, cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      },
    };
  }

  // ── Substitui todas as tools ───────────────────

  pi.registerTool(sandboxTool(
    (cwd) => createReadTool(cwd),
    (config, cwd) => createReadTool(cwd, { operations: createReadOps(config, cwd) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createWriteTool(cwd),
    (config, cwd) => createWriteTool(cwd, { operations: createWriteOps(config, cwd) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createEditTool(cwd),
    (config, cwd) => createEditTool(cwd, { operations: createEditOps(config, cwd) }),
  ));

  // ── Bash tool unificado com bwrap operations ──
  pi.registerTool(sandboxTool(
    (cwd) => createBashTool(cwd),
    (config, cwd) => createBashTool(cwd, { operations: createBashOps(config, cwd) }),
    "bash (sandboxed)",
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createFindTool(cwd),
    (config, cwd) => createFindTool(cwd, { operations: createFindOps(config, cwd) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createLsTool(cwd),
    (config, cwd) => createLsTool(cwd, { operations: createLsOps(config, cwd) }),
  ));

  pi.registerTool(sandboxTool(
    (cwd) => createGrepToolSdk(cwd),
    (config, cwd) => createGrepTool(cwd, config),
  ));

  // ── Tools de quarentena ──────────────────────
  // Exigem sandbox ativo: sem isolamento não há como baixar/executar
  // código externo com segurança (fail-closed, mesmo com --no-sandbox).
  function quarantineBlockedError(toolName: string): Error {
    return new Error(
      `[dev-sandbox] Tool '${toolName}' exige sandbox ativo. ` +
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
          `[dev-sandbox] sandbox_fetch falhou (exit ${result.exitCode}).\n${result.stderr || "sem stderr"}`,
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
      const text = [out, err, `exit code: ${result.exitCode}`].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted },
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
      const target = await promoteArtifact(config, originalCwd, params.source, params.target);
      return {
        content: [{ type: "text", text: `Promoted: ${target}` }],
        details: { target },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_promote_changes",
    label: "Sandbox Promote Changes",
    description: "Promotes tracked and untracked changes from temporary worktree to original project.",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String({ description: "Relative file paths; omit to promote all changes" }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!enabled || !config || !session) throw quarantineBlockedError("sandbox_promote_changes");
      const files = promoteWorktreeChanges(session, params.files ?? []);
      return { content: [{ type: "text", text: `Promoted: ${files.join(", ")}` }], details: { files } };
    },
  });

  // ── user_bash (!comando e !!comando) ──────────
  pi.on("user_bash", (_event, ctx) => {
    const cwd = session?.workspaceCwd ?? ctx?.cwd ?? localCwd;
    if (enabled && config) {
      return { operations: createBashOps(config, cwd) };
    }
    // Opt-out explícito → comportamento padrão do pi
    if (fallbackToHost) return;
    // Fail-closed: bloqueia com mensagem clara
    return {
      result: {
        output:
          "[dev-sandbox] Comando bloqueado: sandbox não está ativo. " +
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
      `Persistent dirs (survive between commands): npm cache ${caches.npm}, pip cache ${caches.pip}, ` +
      `clone remote repos in ${caches.clones}. /tmp is ephemeral — data written there is lost.`;
    const landlockNote = config.landlock.enabled
      ? "\nLandlock filesystem allowlist active."
      : "";
    const quarantineNote =
      "\nInstalling or executing external code (npm install, pip install, curl|bash) is BLOCKED in bash. " +
      "Download/run external code through the quarantine profiles:\n" +
      "- sandbox_fetch: download a file/URL (network ON, NO access to the project).\n" +
      "- sandbox_quarantine_exec: install (npm/pip) or run downloaded code (NO network, NO project " +
      "access, writes only under .sandbox-cache/runs/<work> and configured caches).\n" +
      "- sandbox_promote: copy ONE specific artifact from runs/ back into the project — explicit, " +
      "the only way out.\n" +
      "Use normal bash only for project work.";
    return { systemPrompt: `${event.systemPrompt}\n\n${sandboxNote}${landlockNote}${quarantineNote}` };
  });

  // ── /sandbox command ──────────────────────────
  pi.registerCommand("sandbox", {
    description: "Mostra status e configuração do sandbox",
    handler: async (_args, ctx) => {
      if (!enabled || !config) {
        ctx.ui.notify(
          "Sandbox desabilitado.\nUse '--no-sandbox' para desabilitar ou verifique a instalação do bubblewrap.",
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
        `Worktree: ${session?.worktreePath ?? "desabilitado"}`,
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
    },
  });

  // ── session_shutdown ──────────────────────────
  pi.on("session_shutdown", () => {
    enabled = false;
    config = null;
    releaseSession();
    localCwd = originalCwd;
    fallbackToHost = false;
  });
}
