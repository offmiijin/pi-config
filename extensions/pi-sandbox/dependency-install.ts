/** Plano seguro para instalar dependências npm no worktree atual. */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DependencyInstallPlan {
  command: string[];
  lockfile: boolean;
}

/**
 * Gera comando restrito de instalação. Nunca aceita shell ou argumentos
 * fornecidos pelo usuário; scripts de lifecycle ficam desabilitados.
 */
export function createNpmInstallPlan(cwd: string): DependencyInstallPlan {
  if (!existsSync(join(cwd, "package.json"))) {
    throw new Error(`[pi-sandbox] package.json não encontrado no worktree: ${cwd}`);
  }

  const lockfile = existsSync(join(cwd, "package-lock.json"));
  return {
    command: lockfile ? ["npm", "ci", "--ignore-scripts"] : ["npm", "install", "--ignore-scripts"],
    lockfile,
  };
}
