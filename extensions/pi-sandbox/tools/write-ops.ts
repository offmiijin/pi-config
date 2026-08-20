/**
 * WriteOperations — escrita de arquivos via bwrap.
 */

import type { WriteOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../types";
import { execInSandbox } from "../bwrap-executor";

export function createWriteOps(config: SandboxConfig, cwd: string, workspaceRoot = cwd): WriteOperations {
  const workspace = workspaceRoot !== cwd ? { workspaceRoot } : {};
  return {
    async writeFile(filePath, content) {
      const { stderr, exitCode } = await execInSandbox(config, {
        command: [
          "bash", "-c",
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          "_", filePath,
        ],
        cwd,
        ...workspace,
        stdin: content,
      });
      if (exitCode !== 0) {
        throw new Error(stderr || `Falha ao escrever ${filePath}`);
      }
    },

    async mkdir(dirPath) {
      const { stderr, exitCode } = await execInSandbox(config, {
        command: ["mkdir", "-p", dirPath],
        cwd,
        ...workspace,
      });
      if (exitCode !== 0) {
        throw new Error(stderr || `Falha ao criar diretório ${dirPath}`);
      }
    },
  };
}
