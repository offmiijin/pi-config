/**
 * Testes de config.ts — merge de configuração, normalização SSH e detecção de SO.
 *
 * - deepMerge: merge aninhado, arrays substituem, undefined não sobrescreve
 * - normalizeSshConfig: migração mountReadOnly → mode
 * - loadConfig: precedência default → global → projeto
 * - readOsRelease/matchesOsRelease/getBwrapInstallGuide: guias de instalação
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Estado mutável por teste, visível ao vi.mock (hoisted)
const state = vi.hoisted(() => ({
  agentDir: "/tmp/sb-agent",
  osRelease: "",
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => state.agentDir,
  CONFIG_DIR_NAME: ".pi",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith("/etc/os-release")) return state.osRelease;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    existsSync: (path: unknown) => {
      if (String(path) === "/etc/os-release") return true;
      return actual.existsSync(path as Parameters<typeof actual.existsSync>[0]);
    },
  };
});

import {
  deepMerge, normalizeSshConfig, loadConfig, sanitizeConfig,
  readOsRelease, matchesOsRelease, getBwrapInstallGuide, safeReadJson,
} from "../config";
import { DEFAULT_CONFIG, type SandboxConfig } from "../types";

const fixtures: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"));
  fixtures.push(dir);
  return dir;
}

function writeGlobal(json: string): string {
  const agentDir = fixture();
  const p = join(agentDir, "extensions", "dev-sandbox.json");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(p, json);
  return agentDir;
}

function writeProject(cwd: string, json: string): void {
  const p = join(cwd, ".pi", "sandbox.json");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(p, json);
}

beforeEach(() => {
  state.agentDir = "/tmp/sb-agent";
  state.osRelease = "";
});

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
});

describe("deepMerge", () => {
  it("merge aninhado preserva chaves do base", () => {
    const result = deepMerge(
      { a: { x: 1, y: 2 }, b: 3 },
      { a: { y: 9 }, c: 4 },
    );
    expect(result).toEqual({ a: { x: 1, y: 9 }, b: 3, c: 4 });
  });

  it("arrays substituem (não concatenam)", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("undefined não sobrescreve", () => {
    const result = deepMerge({ a: { x: 1 } }, { a: { x: undefined }, b: undefined });
    expect(result).toEqual({ a: { x: 1 } });
  });

  it("primitivos sobrescrevem", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("override null em objeto base não quebra (null ≠ objeto)", () => {
    const result = deepMerge({ a: { x: 1 } }, { a: null as unknown as Record<string, unknown> });
    expect(result.a).toBeNull();
  });
});

describe("normalizeSshConfig", () => {
  it("mountReadOnly true → mode mount", () => {
    expect(normalizeSshConfig({ mountReadOnly: true })).toEqual({ mode: "mount" });
  });

  it("mountReadOnly false → mode none", () => {
    expect(normalizeSshConfig({ mountReadOnly: false })).toEqual({ mode: "none" });
  });

  it("mode explícito → intacto (ignora mountReadOnly)", () => {
    expect(normalizeSshConfig({ mode: "agent", mountReadOnly: true })).toEqual({
      mode: "agent", mountReadOnly: true,
    });
  });

  it("sem mountReadOnly → intacto", () => {
    expect(normalizeSshConfig({ mode: "agent" })).toEqual({ mode: "agent" });
  });
});

describe("safeReadJson", () => {
  it("arquivo ausente → null", () => {
    expect(safeReadJson(join(tmpdir(), "nao-existe-xyz.json"))).toBeNull();
  });

  it("JSON inválido → null", () => {
    const f = fixture();
    const p = join(f, "bad.json");
    writeFileSync(p, "{ json quebrado");
    expect(safeReadJson(p)).toBeNull();
  });

  it("JSON válido → objeto", () => {
    const f = fixture();
    const p = join(f, "ok.json");
    writeFileSync(p, '{"enabled": false}');
    expect(safeReadJson(p)).toEqual({ enabled: false });
  });
});

describe("loadConfig", () => {
  it("sem arquivos → DEFAULT_CONFIG", () => {
    const config = loadConfig("/cwd/sem-config");
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("global parcial mergeia com defaults", () => {
    const agentDir = writeGlobal('{"internet": {"enabled": false}}');
    state.agentDir = agentDir;
    const config = loadConfig("/cwd/proj");
    expect(config.internet.enabled).toBe(false);
    expect(config.ssh.mode).toBe(DEFAULT_CONFIG.ssh.mode);
    expect(config.filesystem.cacheDirs).toEqual({ npm: "", pip: "", clones: "" });
  });

  it("global com ssh legado (mountReadOnly) é normalizado", () => {
    const agentDir = writeGlobal('{"ssh": {"mountReadOnly": true}}');
    state.agentDir = agentDir;
    expect(loadConfig("/cwd/proj").ssh.mode).toBe("mount");
  });

  it("projeto sobrescreve global", () => {
    const agentDir = writeGlobal('{"internet": {"enabled": false}}');
    state.agentDir = agentDir;
    const cwd = fixture();
    writeProject(cwd, '{"internet": {"enabled": true}, "filesystem": {"denyFilePatterns": [".env.*"]}}');

    const config = loadConfig(cwd);
    expect(config.internet.enabled).toBe(true);
    expect(config.filesystem.denyFilePatterns).toEqual([".env.*"]);
  });

  it("JSON inválido global é ignorado", () => {
    const agentDir = writeGlobal("{ quebrado");
    state.agentDir = agentDir;
    expect(loadConfig("/cwd/proj")).toEqual(DEFAULT_CONFIG);
  });

  it("cacheDirs do global mergeia sem perder clones do default", () => {
    const agentDir = writeGlobal('{"filesystem": {"cacheDirs": {"npm": "/custom/npm"}}}');
    state.agentDir = agentDir;
    const config = loadConfig("/cwd/proj");
    expect(config.filesystem.cacheDirs.npm).toBe("/custom/npm");
    expect(config.filesystem.cacheDirs.pip).toBe("");
    expect(config.filesystem.cacheDirs.clones).toBe("");
  });

  it("projeto não confiável é ignorado (projectTrusted: false)", () => {
    const agentDir = writeGlobal('{"internet": {"enabled": false}}');
    state.agentDir = agentDir;
    const cwd = fixture();
    writeProject(cwd, '{"internet": {"enabled": true}}');

    const untrusted = loadConfig(cwd, { projectTrusted: false });
    expect(untrusted.internet.enabled).toBe(false);
  });

  it("projeto confiável é aplicado (projectTrusted: true)", () => {
    const agentDir = writeGlobal('{"internet": {"enabled": false}}');
    state.agentDir = agentDir;
    const cwd = fixture();
    writeProject(cwd, '{"internet": {"enabled": true}}');

    const trusted = loadConfig(cwd, { projectTrusted: true });
    expect(trusted.internet.enabled).toBe(true);
  });

  it("não muta DEFAULT_CONFIG ao alterar a config retornada", () => {
    const before = JSON.stringify(DEFAULT_CONFIG);
    const cfg = loadConfig("/cwd/proj");
    (cfg as unknown as { seccomp: { bpfPath: string } }).seccomp.bpfPath = "/custom/bpf";
    (cfg as unknown as { enabled: boolean }).enabled = false;
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
    expect(DEFAULT_CONFIG.seccomp.bpfPath).toBe("");
    expect(DEFAULT_CONFIG.enabled).toBe(true);
  });
});

describe("sanitizeConfig", () => {
  it("config válida passa intacta", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.internet.enabled = false;
    cfg.ssh.mode = "none";
    expect(sanitizeConfig(cfg)).toEqual(cfg);
  });

  it("campos com tipo errado voltam ao default", () => {
    const bad = {
      enabled: "yes",
      internet: { enabled: "true" },
      filesystem: {
        denyPaths: "/sbin",
        denyFilePatterns: ".env",
        extraWritable: "x",
        extraReadonly: 42,
        cacheDirs: { npm: 123, pip: false, clones: [] },
      },
      ssh: { mode: "weird" },
      capabilities: { drop: "all" },
      seccomp: { enabled: "on", bpfPath: 7 },
    } as unknown as SandboxConfig;
    expect(sanitizeConfig(bad)).toEqual(DEFAULT_CONFIG);
  });

  it("campos válidos preservados mesmo com outros inválidos", () => {
    const mixed = {
      enabled: false,
      internet: { enabled: false },
      filesystem: { denyPaths: ["/custom"], denyFilePatterns: "broken" },
      capabilities: { drop: ["CAP_SYS_ADMIN", 5] },
    } as unknown as SandboxConfig;
    const out = sanitizeConfig(mixed);
    expect(out.enabled).toBe(false);
    expect(out.internet.enabled).toBe(false);
    expect(out.filesystem.denyPaths).toEqual(["/custom"]);
    expect(out.filesystem.denyFilePatterns).toEqual(DEFAULT_CONFIG.filesystem.denyFilePatterns);
    expect(out.capabilities.drop).toEqual(["CAP_SYS_ADMIN"]);
  });

  it("loadConfig sanea JSON global com tipos inválidos", () => {
    const agentDir = writeGlobal('{"enabled": "sim", "ssh": {"mode": "hack"}, "filesystem": {"denyPaths": "tudo"}}');
    state.agentDir = agentDir;
    expect(loadConfig("/cwd/proj")).toEqual(DEFAULT_CONFIG);
  });
});

describe("readOsRelease / matchesOsRelease / guias", () => {
  it("parse de ID e ID_LIKE", () => {
    state.osRelease = 'ID="ubuntu"\nID_LIKE=debian\n';
    expect(readOsRelease()).toEqual({ id: "ubuntu", idLike: "debian" });
  });

  it("match por ID direto", () => {
    state.osRelease = 'ID="arch"\nID_LIKE=archlinux\n';
    expect(matchesOsRelease(["arch"])).toBe(true);
  });

  it("match por ID_LIKE", () => {
    state.osRelease = 'ID="linuxmint"\nID_LIKE="ubuntu debian"\n';
    expect(matchesOsRelease(["debian"])).toBe(true);
    expect(matchesOsRelease(["arch"])).toBe(false);
  });

  it("conteúdo vazio → sem match (null-safe)", () => {
    state.osRelease = "";
    expect(matchesOsRelease(["ubuntu"])).toBe(false);
  });

  it("guia de instalação por distribuição", () => {
    state.osRelease = 'ID="ubuntu"\nID_LIKE=debian\n';
    expect(getBwrapInstallGuide()).toContain("apt install bubblewrap");
    state.osRelease = 'ID="arch"\n';
    expect(getBwrapInstallGuide()).toContain("pacman -S bubblewrap");
    state.osRelease = 'ID="alpine"\n';
    expect(getBwrapInstallGuide()).toContain("apk add bubblewrap");
  });
});
