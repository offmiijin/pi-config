/** Plano seguro para instalar dependências npm no worktree atual. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DependencyInstallPlan {
  command: string[];
  lockfile: boolean;
}

export type DependencyInstallKind = "npm" | "go" | "cargo" | "pip";

export interface ResolvedDependencyInstallPlan extends DependencyInstallPlan {
  kind: DependencyInstallKind;
  /** Manifesto que originou o plano (ex.: package.json, go.mod). */
  manifest: string;
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

/**
 * Plano de download de módulos Go. `go mod download` só baixa (não compila
 * nem executa nada); o go.sum existente é verificado automaticamente.
 */
export function createGoInstallPlan(cwd: string): DependencyInstallPlan {
  if (!existsSync(join(cwd, "go.mod"))) {
    throw new Error(`[pi-sandbox] go.mod não encontrado no worktree: ${cwd}`);
  }
  return { command: ["go", "mod", "download"], lockfile: existsSync(join(cwd, "go.sum")) };
}

/**
 * Plano de fetch de crates Rust. `cargo fetch` só baixa (build.rs roda apenas
 * no build). Com Cargo.lock, `--locked` garante repetibilidade.
 */
export function createCargoInstallPlan(cwd: string): DependencyInstallPlan {
  if (!existsSync(join(cwd, "Cargo.toml"))) {
    throw new Error(`[pi-sandbox] Cargo.toml não encontrado no worktree: ${cwd}`);
  }
  const lockfile = existsSync(join(cwd, "Cargo.lock"));
  return {
    command: lockfile ? ["cargo", "fetch", "--locked"] : ["cargo", "fetch"],
    lockfile,
  };
}

/** Primeiro requirements* existente (preferindo requirements.txt). */
export function findRequirementsFile(cwd: string): string | null {
  if (existsSync(join(cwd, "requirements.txt"))) return "requirements.txt";
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return null;
  }
  const match = entries.filter((entry) => /^requirements.*\.txt$/.test(entry)).sort()[0];
  return match ?? null;
}

/**
 * Plano de instalação pip. Executa backends de build — exige projeto
 * confiável (gate da tool), como o --ignore-scripts do plano npm.
 */
export function createPipInstallPlan(cwd: string): DependencyInstallPlan {
  const requirements = findRequirementsFile(cwd);
  if (requirements) {
    return {
      command: ["python3", "-m", "pip", "install", "--requirement", join(cwd, requirements)],
      lockfile: ["poetry.lock", "pdm.lock", "uv.lock"].some((file) => existsSync(join(cwd, file))),
    };
  }
  if (!existsSync(join(cwd, "pyproject.toml"))) {
    throw new Error(`[pi-sandbox] nenhum manifesto Python (requirements*.txt, pyproject.toml) no worktree: ${cwd}`);
  }
  return { command: ["python3", "-m", "pip", "install", "."], lockfile: false };
}

/**
 * Escolhe o plano pelo primeiro manifesto suportado (npm → go → cargo → pip).
 * Nunca aceita shell ou argumentos do usuário.
 */
export function createDependencyInstallPlan(cwd: string): ResolvedDependencyInstallPlan {
  if (existsSync(join(cwd, "package.json"))) {
    return { kind: "npm", manifest: "package.json", ...createNpmInstallPlan(cwd) };
  }
  if (existsSync(join(cwd, "go.mod"))) {
    return { kind: "go", manifest: "go.mod", ...createGoInstallPlan(cwd) };
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { kind: "cargo", manifest: "Cargo.toml", ...createCargoInstallPlan(cwd) };
  }
  const requirements = findRequirementsFile(cwd);
  if (requirements || existsSync(join(cwd, "pyproject.toml"))) {
    return { kind: "pip", manifest: requirements ?? "pyproject.toml", ...createPipInstallPlan(cwd) };
  }
  throw new Error(
    `[pi-sandbox] nenhum manifesto suportado no worktree: ${cwd} ` +
    `(package.json, go.mod, Cargo.toml, requirements*.txt, pyproject.toml)`,
  );
}
