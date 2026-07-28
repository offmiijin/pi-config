/**
 * Configuração do pi-memory: global + project-local.
 */

import type { PiMemoryConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Carrega configuração mesclando defaults, global (~/.pi/agent/memory/config.json)
 * e project-local (<project>/.pi/memory.json).
 */
export function loadConfig(project_dir?: string): PiMemoryConfig {
  const config: PiMemoryConfig = deepClone(DEFAULT_CONFIG);

  // Data dir padrão
  config.data_dir = path.join(os.homedir(), ".pi", "agent", "memory");

  // ── Global config ──
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

  // ── Project-local config ──
  if (project_dir) {
    const local_path = path.join(project_dir, ".pi", "memory.json");
    if (fs.existsSync(local_path)) {
      try {
        const raw = fs.readFileSync(local_path, "utf-8");
        const local_cfg = JSON.parse(raw) as Partial<PiMemoryConfig>;
        deepMerge(config, local_cfg);
      } catch {
        // ignora erro de parse
      }
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

  // Reranker
  const oldRerEnabled = r["reranker_enabled"] as boolean | undefined;
  const oldRerLocal = r["reranker_local"] as boolean | undefined;
  const oldRerApi = r["reranker_api"] as boolean | undefined;
  const oldRerModel = r["reranker_model"] as string | undefined;

  if (oldRerLocal !== undefined || oldRerApi !== undefined || oldRerEnabled !== undefined) {
    const rer = r["reranker"] as Record<string, unknown> | undefined;
    if (!rer || typeof rer !== "object") {
      r["reranker"] = { local: { enabled: false }, api: { enabled: false, model: "cohere/rerank-4-pro" } };
    }
    const rerObj = r["reranker"] as Record<string, unknown>;
    const local = rerObj["local"] as Record<string, unknown> | undefined;
    const api = rerObj["api"] as Record<string, unknown> | undefined;

    if (oldRerLocal !== undefined && local && typeof local["enabled"] === "undefined") {
      local["enabled"] = oldRerLocal;
    }
    if (oldRerApi !== undefined && api && typeof api["enabled"] === "undefined") {
      api["enabled"] = oldRerApi;
    }
    if (oldRerModel !== undefined && api && typeof api["model"] === "undefined") {
      api["model"] = oldRerModel;
    }
    if (oldRerEnabled !== undefined && local && api) {
      if (typeof local["enabled"] !== "boolean" && typeof api["enabled"] !== "boolean") {
        const localVal = oldRerEnabled && !oldRerApi;
        const apiVal = oldRerEnabled && oldRerApi;
        local["enabled"] = localVal;
        api["enabled"] = apiVal;
      }
    }

    delete r["reranker_enabled"];
    delete r["reranker_local"];
    delete r["reranker_api"];
    delete r["reranker_model"];
  }
}
