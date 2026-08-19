/**
 * BashOperations para execução dentro do sandbox bwrap.
 *
 * Diferente das outras tools, bash precisa de callback onData
 * para streaming de stdout/stderr em tempo real.
 */

import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../types";
import { buildBwrapArgs, killGroup, wrapWithLandlock } from "../bwrap-executor";

// ─── Bloqueio de instalação/execução externa ────────────────────

/**
 * Mensagem exibida quando um comando de instalação é bloqueado no bash.
 */
const BLOCKED_INSTALL_MSG =
  "[dev-sandbox] Instalação/execução de código externo bloqueada no bash. " +
  "Use as tools de quarentena (sandbox_fetch + sandbox_quarantine_exec) para " +
  "baixar e executar pacotes sem expor o workspace.";

/**
 * Comandos que instalam ou executam código externo DENTRO do workspace.
 * `npm install` roda lifecycle scripts; `pip install` roda backend PEP 517;
 * `curl | bash` executa script arbitrário. Todos devem rodar nos perfis
 * fetch/quarantine, nunca no bash normal (workspace montado read-write).
 */
const BLOCKED_INSTALL_PATTERNS: RegExp[] = [
  // Gerenciadores de pacote — instalação/execução de pacote externo.
  /\bnpm\s+(install|i|ci|add|exec)\b/i,
  /\byarn\s+(add|install|dlx)\b/i,
  /\bpnpm\s+(add|install|dlx)\b/i,
  /\bbunx\b/i,
  /\bnpx\b(?!\s+--no-install\b)/i,
  /\bpip[0-9]*\s+install\b/i,
  /\bpython[0-9.]*\s+-m\s+pip\s+install\b/i,
  /\bpipx\s+install\b/i,
  /\buv\s+pip\s+install\b/i,
  /\bcargo\s+install\b/i,
  /\bgo\s+install\b/i,
  // Download + pipe direto para shell
  /\bcurl\b[^|;\n]*\|\s*(?:sudo\s+)?(ba)?sh\b/i,
  /\bwget\b[^|;\n]*\|\s*(?:sudo\s+)?(ba)?sh\b/i,
  // Bash/sh/source de subshell com download
  /\b(ba)?sh\s+<\(\s*(curl|wget)\b/i,
  /(?<![\w.])(source|\.)\s+<\(\s*(curl|wget)\b/i,
];

/** Detecta comando de instalação/execução externa bloqueado. Exportado para testes. */
export function isBlockedInstall(command: string): boolean {
  return BLOCKED_INSTALL_PATTERNS.some((re) => re.test(command));
}

/**
 * Abre o arquivo BPF se seccomp estiver habilitado.
 * Retorna o fd ou undefined (degradação segura).
 */
function openSeccompFd(config: SandboxConfig): number | undefined {
  const cfg = config.seccomp;
  if (!cfg?.enabled || !cfg.bpfPath || !existsSync(cfg.bpfPath)) {
    return undefined;
  }
  try {
    return openSync(cfg.bpfPath, "r");
  } catch (err) {
    console.warn("[dev-sandbox] Falha ao abrir seccomp.bpf — seccomp desabilitado:", err);
    return undefined;
  }
}

export function createBashOps(
  config: SandboxConfig,
  cwd: string,
  workspaceRoot = cwd,
  onCommandComplete?: () => void,
): BashOperations {
  return {
    async exec(command, cmdCwd, { onData, signal, timeout, env }) {
      // Sinal já abortado antes do spawn → nem cria o processo
      if (signal?.aborted) {
        throw new Error("aborted");
      }

      // Instalação/execução de código externo é redirecionada para os
      // perfis de quarentena — nunca roda no bash com workspace rw.
      if (isBlockedInstall(command)) {
        throw new Error(BLOCKED_INSTALL_MSG);
      }

      let args = buildBwrapArgs(config, cwd, "normal", workspaceRoot);

      // ── Seccomp BPF ────────────────────────
      const bpfFd = openSeccompFd(config);
      if (bpfFd !== undefined) {
        args.push("--seccomp", "3");
      }

      // Variáveis de ambiente customizadas
      if (env) {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === "string") {
            args.push("--setenv", key, value);
          }
        }
      }

      // ── Landlock + comando ────────────────
      // bash -lc carrega profile e tem job control
      args = wrapWithLandlock(args, ["bash", "-lc", command], config, cwd, "normal", workspaceRoot);

      return new Promise((resolve, reject) => {
        // stdio: stdin, stdout, stderr + opcionalmente FD 3 (BPF)
        const stdio: any[] = ["ignore", "pipe", "pipe"];
        if (bpfFd !== undefined) {
          stdio.push(bpfFd);
        }

        const child = spawn("bwrap", args, {
          cwd: cmdCwd,
          stdio,
          detached: true,
          // Env mínimo para o binário bwrap
          env: { PATH: process.env.PATH || "" },
        });

        // Fecha cópia do pai após fork
        if (bpfFd !== undefined) {
          closeSync(bpfFd);
        }

        // Streaming de stdout
        child.stdout!.on("data", (chunk: Buffer) => {
          onData(chunk);
        });

        // Streaming de stderr
        child.stderr!.on("data", (chunk: Buffer) => {
          onData(chunk);
        });

        // Timeout
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killGroup(child);
          }, timeout * 1000);
        }

        // Abort signal
        const onAbort = () => killGroup(child);
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            try { onCommandComplete?.(); } catch { /* tracking não pode falhar o comando */ }
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}
