/**
 * Testes de resolveCacheDirs — resolução de diretórios de cache.
 *
 * Cobre: vazio → default .sandbox-cache/, relativo → contra cwd,
 * absoluto → mantido.
 */

import { describe, it, expect } from "vitest";
import { resolveCacheDirs } from "../bwrap-executor";
import { DEFAULT_CONFIG, type SandboxConfig, type SandboxFilesystemConfig } from "../types";

function makeConfig(over: DeepPartial<SandboxConfig> = {}): SandboxConfig {
  return {
    ...DEFAULT_CONFIG,
    ...over,
    internet: { ...DEFAULT_CONFIG.internet, ...(over.internet ?? {}) },
    filesystem: { ...DEFAULT_CONFIG.filesystem, ...(over.filesystem ?? {}) } as SandboxFilesystemConfig,
    ssh: { ...DEFAULT_CONFIG.ssh, ...(over.ssh ?? {}) },
    capabilities: { ...DEFAULT_CONFIG.capabilities, ...(over.capabilities ?? {}) },
    seccomp: { ...DEFAULT_CONFIG.seccomp, ...(over.seccomp ?? {}) },
    landlock: { ...DEFAULT_CONFIG.landlock, ...(over.landlock ?? {}) },
  };
}

/** DeepPartial para overrides parciais por seção. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U> ? Array<U> : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

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
    delete (cfg.filesystem as unknown as Record<string, unknown>).cacheDirs;
    const dirs = resolveCacheDirs(cfg, "/proj");
    expect(dirs.clones).toBe("/proj/.sandbox-cache/clones");
  });
});
