/**
 * Extensão dev-sandbox — sandbox completo via bubblewrap.
 *
 * Isola todas as tools built-in do pi (read, write, edit, bash,
 * grep, find, ls) dentro de um namespace bwrap com:
 *   - Filesystem restrito (whitelist de /usr, /bin, /lib; /sbin vazio)
 *   - Rede do host compartilhada (para LLM API, npm, git)
 *   - ~/.ssh montado read-only (git push/pull)
 *   - HOME isolado (sem acesso ao home real)
 *
 * Complementa security-guard.ts:
 *   - security-guard = soft boundary (pattern matching, confirmação)
 *   - dev-sandbox    = hard boundary (kernel namespaces)
 *
 * Integração:
 *   - Dev-sandbox registra tool unificado com bwrap operations
 *
 * Configuração:
 *   - ~/.pi/agent/extensions/dev-sandbox.json (global)
 *   - .pi/sandbox.json (projeto)
 *
 * Uso:
 *   pi                          → sandbox ativo por padrão
 *   pi --no-sandbox             → desabilita sandbox
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
import type { SandboxConfig } from "./types";
import { createBashOps } from "./tools/bash-ops";
import { resolveCacheDirs } from "./bwrap-executor";
import { createReadOps } from "./tools/read-ops";
import { createWriteOps } from "./tools/write-ops";
import { createEditOps } from "./tools/edit-ops";
import { createFindOps } from "./tools/find-ops";
import { createLsOps } from "./tools/ls-ops";
import { createGrepTool, setGrepConfig } from "./tools/grep";

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
  let localCwd = process.cwd();

  // ── session_start ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      localCwd = ctx.cwd;

      const noSandbox = pi.getFlag("no-sandbox") as boolean;
      if (noSandbox) {
        enabled = false;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Sandbox desabilitado via --no-sandbox",
            "warning",
          );
        }
        return;
      }

      // Carrega config
      config = loadConfig(localCwd);

      if (!config.enabled) {
        enabled = false;
        return;
      }

      // Verifica bwrap
      if (!isBwrapAvailable()) {
        enabled = false;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "bubblewrap não encontrado. Instale com: apt install bubblewrap",
            "error",
          );
        }
        return;
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
      // Injeta config no grep tool
      setGrepConfig(config);

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
      enabled = false;
      config = null;
      return;
    }

    // Verifica bwrap
    if (!isBwrapAvailable()) {
      enabled = false;
      if (ctx.hasUI) {
        const guide = getBwrapInstallGuide();
        ctx.ui.notify(
          `⚠️ bubblewrap não encontrado. Tools sandbox desativadas.\nInstalação: ${guide}`,
          "error",
        );
      }
      return;
    }

    // Verifica ripgrep (warning não-bloqueante)
    if (!isRgAvailable() && ctx.hasUI) {
      const guide = getRgInstallGuide();
      ctx.ui.notify(
        `⚠️ ripgrep não encontrado. Tool grep pode operar em modo degradado.\nInstalação: ${guide}`,
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

    // Injeta config no grep tool
    setGrepConfig(config);

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
  });

  // ── Substitui todas as tools ───────────────────

  pi.registerTool({
    ...createReadTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createReadTool(cwd);
        return fallback.execute(id, params, signal, onUpdate);
      }
      try {
        const tool = createReadTool(cwd, {
          operations: createReadOps(config, cwd),
        });
        return await tool.execute(id, params, signal, onUpdate);
      } catch (err: any) {
        throw err;
      }
    },
  });

  pi.registerTool({
    ...createWriteTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createWriteTool(cwd);
        return fallback.execute(id, params, signal, onUpdate);
      }
      try {
        const tool = createWriteTool(cwd, {
          operations: createWriteOps(config, cwd),
        });
        return await tool.execute(id, params, signal, onUpdate);
      } catch (err: any) {
        throw err;
      }
    },
  });

  pi.registerTool({
    ...createEditTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createEditTool(cwd);
        return fallback.execute(id, params, signal, onUpdate);
      }
      try {
        const tool = createEditTool(cwd, {
          operations: createEditOps(config, cwd),
        });
        return await tool.execute(id, params, signal, onUpdate);
      } catch (err: any) {
        throw err;
      }
    },
  });

  // ── Bash tool unificado com bwrap operations ──
  pi.registerTool({
    ...createBashTool(localCwd),
    label: "bash (sandboxed)",

    async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createBashTool(cwd);
        return fallback.execute(id, params, signal, onUpdate);
      }

      try {
        const tool = createBashTool(cwd, {
          operations: createBashOps(config, cwd),
        });
        return await tool.execute(id, params, signal, onUpdate);
      } catch (err: any) {
        throw err;
      }
    },
  });

  pi.registerTool({
    ...createFindTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createFindTool(cwd);
        return fallback.execute(id, params, signal, onUpdate);
      }
      try {
        const tool = createFindTool(cwd, {
          operations: createFindOps(config, cwd),
        });
        return await tool.execute(id, params, signal, onUpdate);
      } catch (err: any) {
        throw err;
      }
    },
  });

  pi.registerTool({
    ...createLsTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createLsTool(cwd);
        return fallback.execute(id, params, signal, onUpdate);
      }
      try {
        const tool = createLsTool(cwd, {
          operations: createLsOps(config, cwd),
        });
        return await tool.execute(id, params, signal, onUpdate);
      } catch (err: any) {
        throw err;
      }
    },
  });

  pi.registerTool({
    ...createGrepTool(localCwd),
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? localCwd;
      if (!enabled || !config) {
        const fallback = createGrepToolSdk(cwd);
        return fallback.execute(id, params, signal, onUpdate, ctx);
      }
      try {
        const tool = createGrepTool(cwd);
        return await tool.execute(id, params, signal, onUpdate, ctx);
      } catch (err: any) {
        throw err;
      }
    },
  });

  // ── user_bash (!comando e !!comando) ──────────
  pi.on("user_bash", (_event, ctx) => {
    if (!enabled || !config) return;
    const cwd = ctx?.cwd ?? localCwd;
    return { operations: createBashOps(config, cwd) };
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
  });
}
