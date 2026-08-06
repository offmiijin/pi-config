/**
 * Testes de resolveCacheDirs — resolução de diretórios de cache.
 *
 * Cobre: vazio → default .sandbox-cache/, relativo → contra cwd,
 * absoluto → mantido.
 */

import { describe, it, expect } from "vitest";
import { resolveCacheDirs } from "../bwrap-executor";
import { DEFAULT_CONFIG, type SandboxConfig } from "../types";

function makeConfig(over: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    ...DEFAULT_CONFIG,
    ...over,
    filesystem: { ...DEFAULT_CONFIG.filesystem, ...(over.filesystem ?? {}) },
  };
}

describe("resolveCacheDirs", () => {
  it("vazio → .sandbox-cache/<nome> sob o workspace", () => {
    const dirs = resolveCacheDirs(makeConfig(), "/proj");
    expect(dirs).toEqual({
      npm: "/proj/.sandbox-cache/npm",
      pip: "/proj/.sandbox-cache/pip",
      clones: "/proj/.sandbox-cache/clones",
    });
  });

  it("caminho relativo → resolvido contra o workspace", () => {
    const dirs = resolveCacheDirs(
      makeConfig({ filesystem: { cacheDirs: { npm: "vendor/cache", pip: "", clones: "" } } }),
      "/proj",
    );
    expect(dirs.npm).toBe("/proj/vendor/cache");
    expect(dirs.pip).toBe("/proj/.sandbox-cache/pip");
  });

  it("caminho absoluto → mantido", () => {
    const dirs = resolveCacheDirs(
      makeConfig({ filesystem: { cacheDirs: { npm: "/var/cache/npm", pip: "", clones: "" } } }),
      "/proj",
    );
    expect(dirs.npm).toBe("/var/cache/npm");
  });

  it("config sem cacheDirs (legado) → defaults", () => {
    const cfg = makeConfig();
    delete (cfg.filesystem as Record<string, unknown>).cacheDirs;
    const dirs = resolveCacheDirs(cfg, "/proj");
    expect(dirs.clones).toBe("/proj/.sandbox-cache/clones");
  });
});
