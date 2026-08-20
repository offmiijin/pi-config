/**
 * LsOperations — listagem de diretórios via bwrap.
 *
 * Implementa exists, stat e readdir usando comandos POSIX
 * executados dentro do namespace bwrap.
 */

import type { LsOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../types";
import { execInSandbox } from "../bwrap-executor";

/** Interface compatível com o que o tool ls espera de stat. */
interface StatResult {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
}

export function createLsOps(config: SandboxConfig, cwd: string, workspaceRoot = cwd): LsOperations {
  const workspace = workspaceRoot !== cwd ? { workspaceRoot } : {};
  return {
    async exists(filePath) {
      const { exitCode } = await execInSandbox(config, {
        command: ["test", "-e", filePath],
        cwd,
        ...workspace,
      });
      return exitCode === 0;
    },

    async stat(filePath): Promise<StatResult> {
      // stat --format retorna: tipo|tamanho|mtime_epoch
      const { stdout, exitCode } = await execInSandbox(config, {
        command: ["stat", "--format=%F|%s|%Y", filePath],
        cwd,
        ...workspace,
      });
      if (exitCode !== 0 || !stdout.toString().trim()) {
        throw new Error(`Falha ao stat ${filePath}`);
      }

      const [type, sizeStr, mtimeStr] = stdout.toString().trim().split("|");
      const size = parseInt(sizeStr || "0", 10);
      const mtimeMs = parseFloat(mtimeStr || "0") * 1000;

      return {
        isDirectory: () => type === "directory",
        isFile: () => type === "regular file" || type === "regular empty file",
        isSymbolicLink: () => type === "symbolic link",
        size,
        mtimeMs,
      };
    },

    async readdir(dirPath) {
      // Usa find -printf '%f\0' para retornar só basename (sem caminho)
      const { stdout, exitCode } = await execInSandbox(config, {
        command: [
          "find", dirPath,
          "-maxdepth", "1",
          "-mindepth", "1",
          "-printf", "%f\\0",
        ],
        cwd,
        ...workspace,
      });
      if (exitCode !== 0) {
        throw new Error(`Falha ao listar ${dirPath}`);
      }
      // Split por null byte; último elemento pode ser vazio após trailing \0
      return stdout.toString().split("\0").filter(
        (entry) => entry !== "" && entry !== "." && entry !== "..",
      );
    },
  };
}
