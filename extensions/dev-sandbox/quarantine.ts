/**
 * Operações de quarentena — fetch, execução isolada e promoção de artefatos.
 *
 * Fluxo:
 *   1. sandbox_fetch            → baixa conteúdo em .sandbox-cache/fetch
 *      (perfil fetch: rede ligada, SEM acesso ao workspace).
 *   2. sandbox_quarantine_exec  → executa em .sandbox-cache/runs/<work>
 *      (perfil quarantine: SEM rede, SEM acesso ao workspace).
 *   3. sandbox_promote          → copia artefato de runs/ para o workspace
 *      (ação EXPLÍCITA — único caminho de saída da quarentena).
 */

import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BwrapResult, SandboxConfig } from "./types";
import { ensureQuarantineDir, execInProfile, resolveQuarantineDirs } from "./bwrap-executor";

/** Timeout padrão (segundos) das operações fetch e quarantine. */
export const FETCH_TIMEOUT_S = 150;
export const QUARANTINE_TIMEOUT_S = 300;

/**
 * Valida que `subPath` resolve DENTRO de `baseDir` (anti path-traversal).
 * Retorna o caminho absoluto resolvido. Lança se o path escapar da base
 * ou for vazio.
 */
export function validateQuarantinePath(baseDir: string, subPath: string): string {
  if (subPath === "") {
    throw new Error("[dev-sandbox] Path vazio em área de quarentena.");
  }
  const resolved = resolve(baseDir, subPath);
  const rel = relative(baseDir, resolved);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`[dev-sandbox] Path fora da área de quarentena: ${subPath}`);
  }
  return resolved;
}

/**
 * Baixa `url` (http/https) para o diretório de fetch usando o perfil "fetch":
 * rede ligada, SEM acesso ao workspace. Retorna o path absoluto do arquivo
 * e o BwrapResult da execução do curl.
 */
export async function fetchUrl(
  config: SandboxConfig,
  cwd: string,
  url: string,
  outputName?: string,
  signal?: AbortSignal,
): Promise<{ file: string; result: BwrapResult }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`[dev-sandbox] sandbox_fetch aceita apenas URLs http/https: ${url}`);
  }

  const dirs = resolveQuarantineDirs(config, cwd);
  let output = outputName;
  if (!output || output.trim() === "") {
    try {
      output = basename(new URL(url).pathname) || "download";
    } catch {
      output = "download";
    }
  }
  const file = validateQuarantinePath(dirs.fetch, output);
  const parent = dirname(file);
  if (parent !== dirs.fetch) {
    ensureQuarantineDir(parent);
  }

  const result = await execInProfile(
    config,
    {
      command: ["curl", "-fsSL", "--max-time", String(FETCH_TIMEOUT_S - 30), "-o", file, url],
      cwd: dirs.fetch,
      timeout: FETCH_TIMEOUT_S,
      signal,
    },
    "fetch",
  );
  return { file, result };
}

/**
 * Executa `command` (via bash -lc) no perfil "quarantine": SEM rede, SEM
 * acesso ao workspace. Cria o workdir <runs>/<workSubDir> (persistente entre
 * execuções) e copia os artefatos indicados (paths relativos ao diretório de
 * fetch) para dentro dele, preservando a estrutura. Retorna o BwrapResult.
 */
export async function execQuarantine(
  config: SandboxConfig,
  cwd: string,
  command: string,
  workSubDir = "default",
  artifactPaths: string[] = [],
  signal?: AbortSignal,
): Promise<BwrapResult> {
  if (!command || command.trim() === "") {
    throw new Error("[dev-sandbox] sandbox_quarantine_exec requer um comando.");
  }

  const dirs = resolveQuarantineDirs(config, cwd);
  const workDir = validateQuarantinePath(dirs.runs, workSubDir);
  ensureQuarantineDir(workDir);

  for (const art of artifactPaths) {
    const src = validateQuarantinePath(dirs.fetch, art);
    if (!existsSync(src)) {
      throw new Error(`[dev-sandbox] Artefato não encontrado no fetch: ${art}`);
    }
    const dest = validateQuarantinePath(workDir, art);
    const destParent = dirname(dest);
    if (destParent !== workDir) {
      mkdirSync(destParent, { recursive: true });
    }
    cpSync(src, dest, { recursive: true });
  }

  return execInProfile(
    config,
    {
      command: ["bash", "-lc", command],
      cwd: workDir,
      timeout: QUARANTINE_TIMEOUT_S,
      signal,
    },
    "quarantine",
  );
}

/**
 * Copia um artefato produzido em quarentena (<runs>/<sourceRel>) para o
 * workspace (<cwd>/<targetRel>). Ação EXPLÍCITA — único caminho de saída
 * da quarentena para o projeto. Valida ambos os lados (anti path-traversal
 * e anti-symlink) antes de copiar. Retorna o path absoluto do destino.
 */
export async function promoteArtifact(
  config: SandboxConfig,
  cwd: string,
  sourceRel: string,
  targetRel: string,
): Promise<string> {
  const dirs = resolveQuarantineDirs(config, cwd);

  const src = validateQuarantinePath(dirs.runs, sourceRel);
  if (!existsSync(src)) {
    throw new Error(`[dev-sandbox] Artefato não encontrado na quarentena: ${sourceRel}`);
  }
  // Anti-symlink: resolve o path real e confere que segue dentro de runs/.
  let realSrc: string;
  try {
    realSrc = realpathSync(src);
  } catch {
    throw new Error(`[dev-sandbox] Artefato inacessível: ${sourceRel}`);
  }
  if (realSrc !== dirs.runs && !realSrc.startsWith(dirs.runs + sep)) {
    throw new Error(`[dev-sandbox] Artefato escapa da área de quarentena: ${sourceRel}`);
  }

  const target = validateQuarantinePath(cwd, targetRel);
  const targetParent = dirname(target);
  if (targetParent !== cwd) {
    mkdirSync(targetParent, { recursive: true });
  }
  cpSync(realSrc, target, { recursive: true });
  return target;
}
