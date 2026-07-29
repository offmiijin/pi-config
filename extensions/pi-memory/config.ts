/**
 * Configuração do pi-memory: defaults + global config.json + extra global.
 *
 * Ordem de precedência (último sobrescreve):
 *   1. DEFAULT_CONFIG (types.ts)
 *   2. ~/.pi/agent/memory/config.json (global, criado pelo sistema)
 *   3. ~/.pi/agent/extensions/pi-memory.json (extra global, editado pelo usuário via /memory)
 *
 * Não existe config por projeto — toda configuração é global.
 */

import type { PiMemoryConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Caminho do arquivo de configuração extra global (~/.pi/agent/extensions/pi-memory.json). */
export function extraConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "extensions", "pi-memory.json");
}

/**
 * Carrega configuração mesclando defaults, config.json do data_dir e extensions/pi-memory.json.
 */
export function loadConfig(_project_dir?: string): PiMemoryConfig {
  const config: PiMemoryConfig = deepClone(DEFAULT_CONFIG);

  // Data dir padrão
  config.data_dir = path.join(os.homedir(), ".pi", "agent", "memory");

  // ── Global config (data_dir) ──
  const global_path = path.join(config.data_dir, "config.json");
  if (fs.existsSync(global_path)) {
    try {
      const raw = fs.readFileSync(global_path, "utf-8");
      const global_cfg = JSON.parse(raw) as Partial<PiMemoryConfig>;
      deepMerge(config, global_cfg);
    } catch {
      // ignora erro de parse, usa defaults
    }
  }

  // ── Extra config global (~/.pi/agent/extensions/pi-memory.json) ──
  const extra_path = extraConfigPath();
  if (fs.existsSync(extra_path)) {
    try {
      const raw = fs.readFileSync(extra_path, "utf-8");
      const extra_cfg = JSON.parse(raw) as Partial<PiMemoryConfig>;
      deepMerge(config, extra_cfg);
    } catch {
      // ignora erro de parse
    }
  }

  // ── Flag --no-memory ──
  if (process.env.PI_NO_MEMORY === "1" || process.argv.includes("--no-memory")) {
    config.disabled = true;
  }

  // ── Migração: estrutura antiga → nova ──
  migrateRetrievalConfig(config);

  return config;
}

// ── Helpers ────────────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (isObject(sv) && isObject(tv)) {
      deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      target[key] = sv;
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Migra a estrutura antiga de retrieval (vector_enabled/vector_local/vector_api/vector_model)
 * para a nova (vector.local.enabled / vector.api.enabled / vector.api.model).
 * Roda em memória após merge, sem alterar arquivos no disco.
 */
function migrateRetrievalConfig(config: PiMemoryConfig): void {
  const r = config.retrieval as Record<string, unknown>;

  // Vector
  const oldVecEnabled = r["vector_enabled"] as boolean | undefined;
  const oldVecLocal = r["vector_local"] as boolean | undefined;
  const oldVecApi = r["vector_api"] as boolean | undefined;
  const oldVecModel = r["vector_model"] as string | undefined;

  if (oldVecLocal !== undefined || oldVecApi !== undefined || oldVecEnabled !== undefined) {
    const vec = r["vector"] as Record<string, unknown> | undefined;
    if (!vec || typeof vec !== "object") {
      r["vector"] = { local: { enabled: false }, api: { enabled: false, model: "openai/text-embedding-3-small" } };
    }
    const vecObj = r["vector"] as Record<string, unknown>;
    const local = vecObj["local"] as Record<string, unknown> | undefined;
    const api = vecObj["api"] as Record<string, unknown> | undefined;

    if (oldVecLocal !== undefined && local && typeof local["enabled"] === "undefined") {
      local["enabled"] = oldVecLocal;
    }
    if (oldVecApi !== undefined && api && typeof api["enabled"] === "undefined") {
      api["enabled"] = oldVecApi;
    }
    if (oldVecModel !== undefined && api && typeof api["model"] === "undefined") {
      api["model"] = oldVecModel;
    }
    // Fallback: se vector_enabled existe mas local/api não foram migrados
    if (oldVecEnabled !== undefined && local && api) {
      if (typeof local["enabled"] !== "boolean" && typeof api["enabled"] !== "boolean") {
        const localVal = oldVecEnabled && !oldVecApi;
        const apiVal = oldVecEnabled && oldVecApi;
        local["enabled"] = localVal;
        api["enabled"] = apiVal;
      }
    }

    // Limpa campos antigos
    delete r["vector_enabled"];
    delete r["vector_local"];
    delete r["vector_api"];
    delete r["vector_model"];
  }

}
