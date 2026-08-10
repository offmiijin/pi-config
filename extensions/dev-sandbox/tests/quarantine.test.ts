/**
 * Testes dos perfis de quarentena (fetch/quarantine) e das operações
 * quarantine.ts (execInProfile mockado).
 *
 * Cobre:
 *   - buildBwrapArgs por perfil: mounts (sem workspace), rede, env mínima, SSH ausente
 *   - buildLandlockArgs por perfil: sem --allow-rw do workspace, com dir de quarentena
 *   - resolveQuarantineDirs / ensureQuarantineDir (0o700)
 *   - validateQuarantinePath: path-traversal, absoluto, vazio
 *   - fetchUrl / execQuarantine / promoteArtifact: comandos, cópias, validações
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../bwrap-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bwrap-executor")>();
  return {
    ...actual,
    execInProfile: vi.fn(async () => ({
      stdout: Buffer.from(""),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      aborted: false,
    })),
  };
});

import {
  buildBwrapArgs,
  ensureQuarantineDir,
  execInProfile,
  resolveQuarantineDirs,
  setLandlockExecPath,
  wrapWithLandlock,
} from "../bwrap-executor";
import { fetchUrl, execQuarantine, promoteArtifact, validateQuarantinePath } from "../quarantine";
import { DEFAULT_CONFIG, type SandboxConfig, type SandboxFilesystemConfig, type SandboxProfilesConfig } from "../types";

// ─── Helpers ──────────────────────────────────────────────────

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U> ? Array<U> : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

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
    profiles: { ...DEFAULT_CONFIG.profiles, ...(over.profiles ?? {}) } as SandboxProfilesConfig,
  };
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

function setenvMap(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === "--setenv") m.set(args[i + 1], args[i + 2]);
  }
  return m;
}

const fixtures: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-qar-"));
  fixtures.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(execInProfile).mockClear();
});

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  setLandlockExecPath("");
});

// ─── buildBwrapArgs — perfil fetch ────────────────────────────

describe("buildBwrapArgs — perfil fetch", () => {
  it("rede ligada, dir fetch rw, NUNCA workspace", () => {
    const cwd = fixture();
    const args = buildBwrapArgs(makeConfig(), cwd, "fetch");

    expect(args).toContain("--share-net");
    const binds = flagValues(args, "--bind");
    expect(binds).toContain(join(cwd, ".sandbox-cache", "fetch"));
    expect(binds.filter((b) => b === cwd)).toHaveLength(0);
  });

  it("sem SSH, sem skills, sem .gitconfig", () => {
    const cwd = fixture();
    const args = buildBwrapArgs(makeConfig(), cwd, "fetch");
    expect(flagValues(args, "--ro-bind").some((p) => p.includes(".ssh"))).toBe(false);
    expect(flagValues(args, "--ro-bind").some((p) => p.includes("skills"))).toBe(false);
    expect(flagValues(args, "--ro-bind").some((p) => p.includes(".gitconfig"))).toBe(false);
  });

  it("env mínima: HOME=/tmp, PATH fixo, sem vars do host", () => {
    process.env.GITHUB_TOKEN = "leak-gh";
    try {
      const cwd = fixture();
      const env = setenvMap(buildBwrapArgs(makeConfig(), cwd, "fetch"));
      expect(env.get("HOME")).toBe("/tmp");
      expect(env.get("USER")).toBe("nobody");
      expect(env.get("PATH")).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(env.has("GITHUB_TOKEN")).toBe(false);
      expect(env.has("AWS_SECRET_ACCESS_KEY")).toBe(false);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("network false no perfil desliga rede (kill-switch global respeitado)", () => {
    const cwd = fixture();
    const cfg = makeConfig({ profiles: { fetch: { network: false } } });
    expect(buildBwrapArgs(cfg, cwd, "fetch")).not.toContain("--share-net");
    const offline = makeConfig({ internet: { enabled: false } });
    expect(buildBwrapArgs(offline, cwd, "fetch")).not.toContain("--share-net");
  });
});

// ─── buildBwrapArgs — perfil quarantine ───────────────────────

describe("buildBwrapArgs — perfil quarantine", () => {
  it("sem rede, dir runs rw, NUNCA workspace", () => {
    const cwd = fixture();
    const args = buildBwrapArgs(makeConfig(), cwd, "quarantine");

    expect(args).not.toContain("--share-net");
    const binds = flagValues(args, "--bind");
    expect(binds).toContain(join(cwd, ".sandbox-cache", "runs"));
    expect(binds.filter((b) => b === cwd)).toHaveLength(0);
  });

  it("env mínima igual ao fetch", () => {
    const cwd = fixture();
    const env = setenvMap(buildBwrapArgs(makeConfig(), cwd, "quarantine"));
    expect(env.get("HOME")).toBe("/tmp");
    expect(env.get("PATH")).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

// ─── Landlock por perfil ──────────────────────────────────────

describe("buildBwrapArgs — landlock por perfil", () => {
  function rwValues(args: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--allow-rw") out.push(args[i + 1]);
    }
    return out;
  }

  it("fetch: landlock allow-rw só no dir fetch, nunca workspace", () => {
    const cwd = fixture();
    setLandlockExecPath("/host/landlock-exec");
    const args = buildBwrapArgs(makeConfig(), cwd, "fetch");
    expect(args).toContain("/pi-landlock-exec");
    const full = wrapWithLandlock(args, ["echo", "x"], makeConfig(), cwd, "fetch");
    const rw = rwValues(full);
    expect(rw).toContain(join(cwd, ".sandbox-cache", "fetch"));
    expect(rw).not.toContain(cwd);
  });

  it("quarantine: landlock allow-rw só no dir runs, nunca workspace", () => {
    const cwd = fixture();
    setLandlockExecPath("/host/landlock-exec");
    const args = buildBwrapArgs(makeConfig(), cwd, "quarantine");
    const full = wrapWithLandlock(args, ["echo", "x"], makeConfig(), cwd, "quarantine");
    const rw = rwValues(full);
    expect(rw).toContain(join(cwd, ".sandbox-cache", "runs"));
    expect(rw).not.toContain(cwd);
  });
});

// ─── resolveQuarantineDirs / ensureQuarantineDir ──────────────

describe("resolveQuarantineDirs / ensureQuarantineDir", () => {
  it("defaults sob o workspace", () => {
    const cwd = fixture();
    expect(resolveQuarantineDirs(makeConfig(), cwd)).toEqual({
      fetch: join(cwd, ".sandbox-cache", "fetch"),
      runs: join(cwd, ".sandbox-cache", "runs"),
    });
  });

  it("caminho custom absoluto é mantido", () => {
    const cwd = fixture();
    const cfg = makeConfig({ filesystem: { quarantineDirs: { fetch: "/custom/fetch", runs: "" } } });
    const dirs = resolveQuarantineDirs(cfg, cwd);
    expect(dirs.fetch).toBe("/custom/fetch");
    expect(dirs.runs).toBe(join(cwd, ".sandbox-cache", "runs"));
  });

  it("ensureQuarantineDir cria com 0o700", () => {
    const cwd = fixture();
    const dir = join(cwd, "sub", "fetch");
    ensureQuarantineDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

// ─── validateQuarantinePath ───────────────────────────────────

describe("validateQuarantinePath", () => {
  it("path dentro da base resolve", () => {
    expect(validateQuarantinePath("/base", "x/y.tar.gz")).toBe("/base/x/y.tar.gz");
    expect(validateQuarantinePath("/base", "file.txt")).toBe("/base/file.txt");
  });

  it("bloqueia path-traversal", () => {
    expect(() => validateQuarantinePath("/base", "../evil")).toThrow(/fora/);
    expect(() => validateQuarantinePath("/base", "a/../../evil")).toThrow(/fora/);
  });

  it("bloqueia absoluto e vazio", () => {
    expect(() => validateQuarantinePath("/base", "/etc/passwd")).toThrow(/fora/);
    expect(() => validateQuarantinePath("/base", "")).toThrow(/vazio/);
  });
});

// ─── fetchUrl ─────────────────────────────────────────────────

describe("fetchUrl", () => {
  it("monta curl com -o no dir fetch", async () => {
    const cwd = fixture();
    const { file, result } = await fetchUrl(
      makeConfig(), cwd, "https://ex.com/a.tar.gz", "pkg/a.tar.gz",
    );
    expect(file).toBe(join(cwd, ".sandbox-cache", "fetch", "pkg", "a.tar.gz"));
    const cmd = vi.mocked(execInProfile).mock.calls[0][1].command;
    expect(cmd[0]).toBe("curl");
    expect(cmd).toContain(file);
    expect(cmd).toContain(urlOf(cmd) ?? "");
    expect(result.exitCode).toBe(0);
  });

  it("output default = basename da URL", async () => {
    const cwd = fixture();
    const { file } = await fetchUrl(makeConfig(), cwd, "https://ex.com/pkg.tar.gz");
    expect(file).toBe(join(cwd, ".sandbox-cache", "fetch", "pkg.tar.gz"));
  });

  it("rejeita URL não-http e output traversal", async () => {
    const cwd = fixture();
    await expect(fetchUrl(makeConfig(), cwd, "file:///etc/passwd", "x")).rejects.toThrow(/http/);
    await expect(fetchUrl(makeConfig(), cwd, "https://ex.com/a", "../x")).rejects.toThrow(/fora/);
  });
});

function urlOf(cmd: string[]): string | undefined {
  return cmd.find((c) => c.startsWith("http"));
}

// ─── execQuarantine ───────────────────────────────────────────

describe("execQuarantine", () => {
  it("cria workdir e copia artefatos antes de executar", async () => {
    const cwd = fixture();
    const fetchDir = join(cwd, ".sandbox-cache", "fetch");
    mkdirSync(fetchDir, { recursive: true });
    writeFileSync(join(fetchDir, "pkg.tar.gz"), "DATA");

    const res = await execQuarantine(makeConfig(), cwd, "tar xf pkg.tar.gz", "run1", ["pkg.tar.gz"]);
    const cmd = vi.mocked(execInProfile).mock.calls[0][1].command;
    expect(cmd).toEqual(["bash", "-lc", "tar xf pkg.tar.gz"]);
    const copied = join(cwd, ".sandbox-cache", "runs", "run1", "pkg.tar.gz");
    expect(statSync(copied).isFile()).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("workdir default é 'default' e persiste entre chamadas", async () => {
    const cwd = fixture();
    await execQuarantine(makeConfig(), cwd, "echo 1");
    const workDir = vi.mocked(execInProfile).mock.calls[0][1].cwd;
    expect(workDir).toBe(join(cwd, ".sandbox-cache", "runs", "default"));
    await execQuarantine(makeConfig(), cwd, "echo 2");
    expect(vi.mocked(execInProfile).mock.calls[1][1].cwd).toBe(workDir);
  });

  it("rejeita comando vazio, artefato inexistente e traversal", async () => {
    const cwd = fixture();
    await expect(execQuarantine(makeConfig(), cwd, "   ")).rejects.toThrow(/comando/);
    await expect(execQuarantine(makeConfig(), cwd, "ls", "run", ["nao-existe"])).rejects.toThrow(/não encontrado/);
    await expect(execQuarantine(makeConfig(), cwd, "ls", "../escape")).rejects.toThrow(/fora/);
  });
});

// ─── promoteArtifact ──────────────────────────────────────────

describe("promoteArtifact", () => {
  it("copia artefato de runs para o workspace", async () => {
    const cwd = fixture();
    const runDir = join(cwd, ".sandbox-cache", "runs", "default");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "out.js"), "// ok");

    const target = await promoteArtifact(makeConfig(), cwd, "default/out.js", "dist/out.js");
    expect(target).toBe(join(cwd, "dist", "out.js"));
    expect(statSync(join(cwd, "dist", "out.js")).isFile()).toBe(true);
  });

  it("bloqueia source inexistente, traversal e target fora do workspace", async () => {
    const cwd = fixture();
    const runDir = join(cwd, ".sandbox-cache", "runs", "default");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "out.js"), "// ok");

    await expect(promoteArtifact(makeConfig(), cwd, "default/nao-existe", "x")).rejects.toThrow(/não encontrado/);
    await expect(promoteArtifact(makeConfig(), cwd, "default/../../etc/passwd", "x")).rejects.toThrow(/fora/);
    await expect(promoteArtifact(makeConfig(), cwd, "default/out.js", "../escape")).rejects.toThrow(/fora/);
  });

  it("bloqueia symlink que escapa de runs", async () => {
    const cwd = fixture();
    const runDir = join(cwd, ".sandbox-cache", "runs", "default");
    mkdirSync(runDir, { recursive: true });
    const outside = join(cwd, "outside-secret.txt");
    writeFileSync(outside, "SECRET");
    symlinkSync(outside, join(runDir, "link.txt"));

    await expect(promoteArtifact(makeConfig(), cwd, "default/link.txt", "out.txt")).rejects.toThrow(/escapa/);
  });
});
