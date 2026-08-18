/** Limpeza conservadora de caches persistentes e áreas de quarentena. */

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Retenção padrão para artefatos sem atividade. */
export const CACHE_RETENTION_DAYS = 30;
export const CACHE_RETENTION_MS = CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function newestMtime(path: string): number {
  let newest = 0;
  try {
    const stat = lstatSync(path);
    newest = stat.mtimeMs;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return newest;

    for (const entry of readdirSync(path, { withFileTypes: true })) {
      newest = Math.max(newest, newestMtime(join(path, entry.name)));
    }
  } catch {
    // Corrida, permissão ou item removido: limpeza segue best-effort.
  }
  return newest;
}

function removeIfStale(path: string, cutoff: number): boolean {
  if (newestMtime(path) >= cutoff) return false;
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove arquivos antigos de cache, preservando diretórios estruturais. */
function prunePackageCache(root: string, cutoff: number): number {
  let removed = 0;
  if (!existsSync(root)) return removed;

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        removed += prunePackageCache(path, cutoff);
        continue;
      }
      if (removeIfStale(path, cutoff)) removed++;
    }
  } catch {
    // Diretório inacessível ou removido durante a varredura.
  }
  return removed;
}

/** Remove entradas antigas inteiras (runs, clones e downloads). */
function pruneEntryCache(root: string, cutoff: number): number {
  let removed = 0;
  if (!existsSync(root)) return removed;

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (removeIfStale(join(root, entry.name), cutoff)) removed++;
    }
  } catch {
    // Diretório inacessível ou removido durante a varredura.
  }
  return removed;
}

export interface CacheCleanupResult {
  removed: number;
}

/**
 * Limpa artefatos sem atividade recente.
 *
 * npm/pip são caches de arquivos e podem ser podados internamente.
 * clones, fetch e runs são tratados como unidades para não corromper
 * repositórios ou ambientes virtuais ainda em uso.
 */
export function cleanupSandboxCaches(
  cacheDirs: Record<string, string>,
  quarantineDirs: { fetch: string; runs: string },
  now = Date.now(),
): CacheCleanupResult {
  const cutoff = now - CACHE_RETENTION_MS;
  let removed = 0;

  removed += prunePackageCache(cacheDirs.npm, cutoff);
  removed += prunePackageCache(cacheDirs.pip, cutoff);
  removed += pruneEntryCache(cacheDirs.clones, cutoff);
  removed += pruneEntryCache(quarantineDirs.fetch, cutoff);
  removed += pruneEntryCache(quarantineDirs.runs, cutoff);

  return { removed };
}
