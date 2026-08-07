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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { DEFAULT_CONFIG, type SandboxConfig } from "./types";
import { createBashOps } from "./tools/bash-ops";
import { resolveCacheDirs } from "./bwrap-executor";
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

  // ── Substitui todas as tools ───────────────────

  pi.registerTool({
    ...createReadTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createReadTool(cwd).execute(id, params, signal, onUpdate);
        throw sandboxBlockedError("read");
      }
      const tool = createReadTool(cwd, {
        operations: createReadOps(config, cwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createWriteTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createWriteTool(cwd).execute(id, params, signal, onUpdate);
        throw sandboxBlockedError("write");
      }
      const tool = createWriteTool(cwd, {
        operations: createWriteOps(config, cwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createEditTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createEditTool(cwd).execute(id, params, signal, onUpdate);
        throw sandboxBlockedError("edit");
      }
      const tool = createEditTool(cwd, {
        operations: createEditOps(config, cwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // ── Bash tool unificado com bwrap operations ──
  pi.registerTool({
    ...createBashTool(localCwd),
    label: "bash (sandboxed)",

    async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createBashTool(cwd).execute(id, params, signal, onUpdate);
        throw sandboxBlockedError("bash");
      }
      const tool = createBashTool(cwd, {
        operations: createBashOps(config, cwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createFindTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createFindTool(cwd).execute(id, params, signal, onUpdate);
        throw sandboxBlockedError("find");
      }
      const tool = createFindTool(cwd, {
        operations: createFindOps(config, cwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createLsTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createLsTool(cwd).execute(id, params, signal, onUpdate);
        throw sandboxBlockedError("ls");
      }
      const tool = createLsTool(cwd, {
        operations: createLsOps(config, cwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...createGrepTool(localCwd, DEFAULT_CONFIG),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        if (fallbackToHost) return createGrepToolSdk(cwd).execute(id, params, signal, onUpdate, ctx);
        throw sandboxBlockedError("grep");
      }
      const tool = createGrepTool(cwd, config);
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

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
    // Concatena ao system prompt existente em vez de substituí-lo,
    // preservando o conteúdo injetado por outras extensões (ex: agent-type).
    return { systemPrompt: `${event.systemPrompt}\n\n${sandboxNote}` };
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
