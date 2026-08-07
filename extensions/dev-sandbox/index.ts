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
 * Complementa security-guard.ts:
 *   - security-guard = soft boundary (pattern matching, confirmação)
 *   - dev-sandbox    = hard boundary (kernel namespaces)
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
import type { SandboxConfig } from "./types";
import { createBashOps } from "./tools/bash-ops";
import { resolveCacheDirs, probeLandlockAbi, setLandlockExecPath } from "./bwrap-executor";
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

  // ── session_start ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    localCwd = ctx.cwd;
    enabled = false;
    config = null;
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
      config = loadConfig(localCwd, { projectTrusted: ctx.isProjectTrusted?.() ?? false });

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

      // ── Seccomp BPF ───────────────────────────
      // Resolve caminho do BPF se não configurado explicitamente
      if (!config.seccomp.bpfPath) {
        config.seccomp.bpfPath = join(EXT_DIR, "seccomp.bpf");
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
      if (config.landlock.enabled) {
        const hostPath = join(EXT_DIR, "gen-seccomp", "target", "release", "landlock-exec");
        if (!existsSync(hostPath)) {
          if (config.landlock.required) {
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Landlock está habilitado e é obrigatório, mas o helper não foi encontrado.\n` +
                `Caminho esperado: ${hostPath}\n` +
                "Compile com: cd extensions/dev-sandbox/gen-seccomp && cargo build --release\n" +
                'Ou desabilite: {"landlock": {"enabled": false}}',
                "error",
              );
            }
            return; // fail-closed: sandbox não ativa
          }
          console.warn("[dev-sandbox] landlock-exec não encontrado — Landlock desabilitado.");
          config.landlock.enabled = false;
        } else {
          const abi = probeLandlockAbi(hostPath);
          if (abi === null || abi < config.landlock.minAbi) {
            if (config.landlock.required) {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  `Landlock requer ABI >= ${config.landlock.minAbi}, ` +
                  `detectada: ${abi ?? "indisponível"}. Execução bloqueada.`,
                  "error",
                );
              }
              return; // fail-closed
            }
            console.warn(
              `[dev-sandbox] Landlock ABI insuficiente (${abi ?? "N/A"} < ${config.landlock.minAbi}) — modo degradado.`
            );
            config.landlock.enabled = false;
          } else {
            // Helper disponível e ABI compatível — registra para montagem
            setLandlockExecPath(hostPath);
          }
        }
      }

      enabled = true;

      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "sandbox",
          `[🔒 Sandbox ativo] ${localCwd}`,
        );
        ctx.ui.notify(
          `Sandbox inicializado.\nWorkspace: ${localCwd}\nRede: ${config.internet.enabled ? "compartilhada" : "isolada"}`,
          "info",
        );
      }
    } catch (err: any) {
      // Erro inesperado → fail-closed: nunca roda sem sandbox silenciosamente
      enabled = false;
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
        const cwd = ctx.cwd ?? localCwd;
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

  // ── user_bash (!comando e !!comando) ──────────
  pi.on("user_bash", (_event, ctx) => {
    const cwd = ctx?.cwd ?? localCwd;
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
    const cwd = ctx?.cwd ?? localCwd;
    const caches = resolveCacheDirs(config, cwd);
    const sandboxNote =
      `Current working directory: ${cwd} (sandboxed — bubblewrap namespaces)\n` +
      `Persistent dirs (survive between commands): npm cache ${caches.npm}, pip cache ${caches.pip}, ` +
      `clone remote repos in ${caches.clones}. /tmp is ephemeral — data written there is lost.`;
    const landlockNote = config.landlock.enabled
      ? "\nLandlock filesystem allowlist active."
      : "";
    return { systemPrompt: `${event.systemPrompt}\n\n${sandboxNote}${landlockNote}` };
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
      const lines = [
        `🔒 Sandbox de Desenvolvimento`,
        ``,
        `Status: ativo`,
        `Workspace: ${localCwd}`,
        `Rede: ${config.internet.enabled ? "compartilhada com host" : "isolada"}`,
        `SSH: ${config.ssh.mode === "agent" ? "ssh-agent socket" : config.ssh.mode === "mount" ? "~/.ssh montado read-only" : "não montado"}`,
        `Landlock: ${config.landlock.enabled ? "ativo (ABI min: " + config.landlock.minAbi + ")" : "desabilitado"}`,
        `Seccomp: ${config.seccomp.enabled ? "ativo (" + config.seccomp.bpfPath + ")" : "desabilitado"}`,
        `Capabilities: ${config.capabilities.drop.length} droppadas`,
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
    fallbackToHost = false;
  });
}
