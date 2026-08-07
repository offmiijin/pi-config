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

export function createBashOps(config: SandboxConfig, cwd: string): BashOperations {
  return {
    async exec(command, cmdCwd, { onData, signal, timeout, env }) {
      // Sinal já abortado antes do spawn → nem cria o processo
      if (signal?.aborted) {
        throw new Error("aborted");
      }

      let args = buildBwrapArgs(config, cwd);

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
      args = wrapWithLandlock(args, ["bash", "-lc", command], config, cwd);

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
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}
