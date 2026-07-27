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
