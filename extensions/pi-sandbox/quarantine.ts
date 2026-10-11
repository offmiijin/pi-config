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
/** Teto do download (bytes) — sem ele um alvo gigante enche o disco. */
export const FETCH_MAX_FILE_SIZE = 512 * 1024 * 1024;

/**
 * Valida que `subPath` resolve DENTRO de `baseDir` (anti path-traversal).
 * Retorna o caminho absoluto resolvido. Lança se o path escapar da base
 * ou for vazio.
 */
export function validateQuarantinePath(baseDir: string, subPath: string): string {
  if (subPath === "") {
    throw new Error("[pi-sandbox] Path vazio em área de quarentena.");
  }
  const resolved = resolve(baseDir, subPath);
  const rel = relative(baseDir, resolved);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`[pi-sandbox] Path fora da área de quarentena: ${subPath}`);
  }
  return resolved;
}

function assertRealPathInside(baseDir: string, target: string, label: string): void {
  const baseReal = realpathSync(baseDir);
  let existing = resolve(target);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  if (realExisting !== baseReal && !realExisting.startsWith(baseReal + sep)) {
    throw new Error(`[pi-sandbox] ${label} escapa da área permitida: ${target}`);
  }
}

/** Rede efetiva do perfil fetch (kill-switch global + flag do perfil). */
export function isFetchNetworkEnabled(config: SandboxConfig): boolean {
  return config.internet.enabled && (config.profiles?.fetch?.network ?? true);
}

/** Preflight: garante que o curl existe DENTRO do sandbox (PATH mínimo). */
async function checkCurlAvailable(config: SandboxConfig, cwd: string): Promise<void> {
  const dirs = resolveQuarantineDirs(config, cwd);
  const probe = await execInProfile(
    config,
    { command: ["curl", "--version"], cwd: dirs.fetch, baseCwd: cwd, timeout: 30 },
    "fetch",
  );
  if (probe.exitCode !== 0) {
    throw new Error("[pi-sandbox] curl indisponível no sandbox — instale o curl no host para usar o sandbox_fetch.");
  }
}

/** Causa provável a partir do exit code do curl + última linha do stderr. */
export function classifyFetchError(exitCode: number | null, stderr: string, url: string): string {
  const lastLine = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const detail = lastLine ? ` (${lastLine.slice(0, 200)})` : "";
  switch (exitCode) {
    case 6:
      return `[pi-sandbox] sandbox_fetch falhou: DNS não resolveu ${url}${detail}. Verifique a rede e o /etc/resolv.conf do host.`;
    case 7:
      return `[pi-sandbox] sandbox_fetch falhou: conexão recusada/falhou em ${url}${detail}. O servidor pode estar fora do ar.`;
    case 28:
      return `[pi-sandbox] sandbox_fetch falhou: tempo esgotado em ${url}${detail}. Tente novamente ou use URL menor.`;
    case 60:
    case 77:
      return `[pi-sandbox] sandbox_fetch falhou: certificado TLS rejeitado em ${url}${detail}. Verifique o CA store do host (/etc/ssl, /etc/pki).`;
    case 22:
      return `[pi-sandbox] sandbox_fetch falhou: HTTP recusou ${url}${detail}. Verifique se a URL existe.`;
    case 63:
      return `[pi-sandbox] sandbox_fetch falhou: ${url} excede o limite de ${Math.round(FETCH_MAX_FILE_SIZE / 1024 / 1024)}MB${detail}.`;
    case 127:
      return `[pi-sandbox] sandbox_fetch falhou: curl não encontrado no sandbox${detail}. Instale o curl no host.`;
    default:
      return `[pi-sandbox] sandbox_fetch falhou (exit ${exitCode ?? "desconhecido"}) em ${url}${detail}.`;
  }
}

/**
 * Baixa `url` (http/https) para o diretório de fetch usando o perfil "fetch":
 * rede ligada, SEM acesso ao workspace. Recusa cedo sem rede efetiva, faz
 * preflight do curl, tenta com retry e classifica falhas em mensagens
 * acionáveis. Remove download parcial em falha. Retorna o path absoluto do
 * arquivo e o BwrapResult da execução do curl.
 */
export async function fetchUrl(
  config: SandboxConfig,
  cwd: string,
  url: string,
  outputName?: string,
  signal?: AbortSignal,
): Promise<{ file: string; result: BwrapResult }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`[pi-sandbox] sandbox_fetch aceita apenas URLs http/https: ${url}`);
  }
  if (!isFetchNetworkEnabled(config)) {
    throw new Error(
      "[pi-sandbox] sandbox_fetch exige rede: habilite internet.enabled e profiles.fetch.network na configuração."
    );
  }
  await checkCurlAvailable(config, cwd);

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
      command: [
        "curl", "-fsSL",
        "--proto", "=http,https", "--proto-redir", "=http,https",
        "--retry", "2", "--retry-delay", "2",
        "--max-time", String(FETCH_TIMEOUT_S - 30),
        "--max-filesize", String(FETCH_MAX_FILE_SIZE),
        "-o", file, url,
      ],
      cwd: dirs.fetch,
      baseCwd: cwd,
      timeout: FETCH_TIMEOUT_S,
      signal,
    },
    "fetch",
  );
  if (result.exitCode !== 0) {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(file, { force: true });
    } catch {
      // Melhor esforço — parcial restante é sobrescrito na próxima tentativa.
    }
    throw new Error(classifyFetchError(result.exitCode, result.stderr, url));
  }
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
    throw new Error("[pi-sandbox] sandbox_quarantine_exec requer um comando.");
  }

  const dirs = resolveQuarantineDirs(config, cwd);
  const workDir = validateQuarantinePath(dirs.runs, workSubDir);
  ensureQuarantineDir(workDir);

  for (const art of artifactPaths) {
    const src = validateQuarantinePath(dirs.fetch, art);
    if (!existsSync(src)) {
      throw new Error(`[pi-sandbox] Artefato não encontrado no fetch: ${art}`);
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
      baseCwd: cwd,
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
    throw new Error(`[pi-sandbox] Artefato não encontrado na quarentena: ${sourceRel}`);
  }
  // Anti-symlink: resolve o path real e confere que segue dentro de runs/.
  let realSrc: string;
  try {
    realSrc = realpathSync(src);
  } catch {
    throw new Error(`[pi-sandbox] Artefato inacessível: ${sourceRel}`);
  }
  if (realSrc !== dirs.runs && !realSrc.startsWith(dirs.runs + sep)) {
    throw new Error(`[pi-sandbox] Artefato escapa da área de quarentena: ${sourceRel}`);
  }

  const target = validateQuarantinePath(cwd, targetRel);
  assertRealPathInside(cwd, target, "Destino de promoção");
  const targetParent = dirname(target);
  if (targetParent !== cwd) {
    mkdirSync(targetParent, { recursive: true });
  }
  assertRealPathInside(cwd, target, "Destino de promoção");
  cpSync(realSrc, target, { recursive: true });
  return target;
}
