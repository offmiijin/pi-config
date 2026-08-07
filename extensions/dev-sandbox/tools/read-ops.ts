/**
 * ReadOperations — leitura de arquivos via bwrap.
 */

import { Buffer } from "node:buffer";
import type { ReadOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../types";
import { execInSandbox } from "../bwrap-executor";

export function createReadOps(config: SandboxConfig, cwd: string): ReadOperations {
  return {
    async readFile(filePath) {
      const { stdout, stderr, exitCode } = await execInSandbox(config, {
        command: ["cat", filePath],
        cwd,
      });
      if (exitCode !== 0) {
        throw new Error(stderr || `Falha ao ler ${filePath}`);
      }
      // stdout já é Buffer — bytes exatos, sem corromper binário
      return stdout;
    },

    async access(filePath) {
      // test -f → exit 0 se existe, 1 se não
      const { exitCode } = await execInSandbox(config, {
        command: ["test", "-f", filePath],
        cwd,
      });
      if (exitCode !== 0) {
        throw new Error(`Arquivo não acessível: ${filePath}`);
      }
    },

    async detectImageMimeType(filePath) {
      try {
        const { stdout } = await execInSandbox(config, {
          command: ["file", "--mime-type", "-b", filePath],
          cwd,
        });
        const mime = stdout.toString().trim();
        const mimeMap: Record<string, string> = {
          "image/png": "image/png",
          "image/jpeg": "image/jpeg",
          "image/gif": "image/gif",
          "image/webp": "image/webp",
        };
        return mimeMap[mime] || null;
      } catch {
        return null;
      }
    },
  };
}
