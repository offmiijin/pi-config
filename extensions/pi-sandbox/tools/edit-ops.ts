/**
 * EditOperations — edição de arquivos via bwrap.
 *
 * Compõe ReadOperations + WriteOperations.
 * O tool edit do pi usa readFile para ler o arquivo atual
 * e writeFile para escrever o novo conteúdo após o patch.
 */

import type { EditOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../types";
import { createReadOps } from "./read-ops";
import { createWriteOps } from "./write-ops";

export function createEditOps(config: SandboxConfig, cwd: string, workspaceRoot = cwd): EditOperations {
  const readOps = createReadOps(config, cwd, workspaceRoot);
  const writeOps = createWriteOps(config, cwd, workspaceRoot);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}
