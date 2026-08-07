/**
 * Testes da integração Landlock — args, probe ABI e wrap.
 *
 * Cobre: probeLandlockAbi (cache, sucesso, falha), buildLandlockArgs
 * (paths RO/RW, caches, extra paths, SSH socket), wrapWithLandlock
 * (habilitado/desabilitado), setLandlockExecPath + mount no buildBwrapArgs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// ─── Mock buffer para controlar chamadas ──────────────────────

const execBuffer: Array<{ stdout: string; error: boolean }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (_path: string, _args: string[], _opts: unknown) => {
      const next = execBuffer.shift();
      if (!next || next.error) {
        const err = new Error("mock error") as Error & { code?: string; stderr?: Buffer };
        err.code = "ENOENT";
        err.stderr = Buffer.from("mock stderr");
        throw err;
      }
      return Buffer.from(next.stdout);
    },
  };
});

import {
  probeLandlockAbi,
  wrapWithLandlock,
  setLandlockExecPath,
  buildBwrapArgs,
  resetLandlockAbiCache,
} from "../bwrap-executor";
import { DEFAULT_CONFIG, type SandboxConfig, type SandboxFilesystemConfig } from "../types";

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
  };
}

const fixtures: string[] = [];
const originalHome = process.env.HOME;
const originalSshSock = process.env.SSH_AUTH_SOCK;

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sb-lhome-"));
  fixtures.push(home);
  return home;
}

function fixtureProj(): string {
  const proj = mkdtempSync(join(tmpdir(), "sb-lproj-"));
  fixtures.push(proj);
  return proj;
}

beforeEach(() => {
  execBuffer.length = 0;
  setLandlockExecPath("");
  resetLandlockAbiCache();
  process.env.HOME = fixtureHome();
});

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalSshSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = originalSshSock;
});

// ─── probeLandlockAbi ─────────────────────────────────────────

describe("probeLandlockAbi", () => {
  it("retorna ABI do stdout do helper", () => {
    execBuffer.push({ stdout: "5\n", error: false });
    const abi = probeLandlockAbi("/fake/landlock-exec");
    expect(abi).toBe(5);
  });

  it("cacheia resultado — segunda chamada não reexecuta", () => {
    execBuffer.push({ stdout: "3\n", error: false });
    const a = probeLandlockAbi("/fake/landlock-exec");
    const b = probeLandlockAbi("/fake/landlock-exec");
    expect(a).toBe(3);
    expect(b).toBe(3);
    // Buffer ainda tem 0 itens — não foi consumido na segunda chamada
    expect(execBuffer.length).toBe(0);
  });

  it("ABI zero → null", () => {
    execBuffer.push({ stdout: "0\n", error: false });
    expect(probeLandlockAbi("/fake/landlock-exec")).toBeNull();
  });

  it("stdout inválido → null", () => {
    execBuffer.push({ stdout: "abc\n", error: false });
    expect(probeLandlockAbi("/fake/landlock-exec")).toBeNull();
  });

  it("execFileSync lança → null", () => {
    execBuffer.push({ stdout: "", error: true });
    expect(probeLandlockAbi("/fake/landlock-exec")).toBeNull();
  });

  it("ABI negativa → null", () => {
    execBuffer.push({ stdout: "-1\n", error: false });
    expect(probeLandlockAbi("/fake/landlock-exec")).toBeNull();
  });
});

// ─── wrapWithLandlock ─────────────────────────────────────────

describe("wrapWithLandlock", () => {
  it("landlock disabled → passthrough (sem landlock-exec)", () => {
    const cfg = makeConfig({ landlock: { enabled: false } });
    const result = wrapWithLandlock(
      ["--unshare-all", "--bind", "/w", "/w"],
      ["echo", "hello"],
      cfg,
      "/w",
    );
    expect(result).not.toContain("/pi-landlock-exec");
    expect(result).toEqual(["--unshare-all", "--bind", "/w", "/w", "echo", "hello"]);
  });

  it("landlock enabled → prepends /pi-landlock-exec com args", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const proj = fixtureProj();
    const cfg = makeConfig();

    const result = wrapWithLandlock(
      ["--unshare-all"],
      ["bash", "-c", "ls"],
      cfg,
      proj,
    );

    const idx = result.indexOf("/pi-landlock-exec");
    expect(idx).toBeGreaterThan(-1);
    expect(result[idx + 1]).toBe("--min-abi");
    expect(result[idx + 2]).toBe("3");

    // RO paths obrigatórios
    const roPaths = result.slice(
      result.indexOf("--allow-ro"),
      result.indexOf("--allow-rw"),
    );
    expect(roPaths).toContain("--allow-ro");
    expect(roPaths).toContain("/usr");
    expect(roPaths).toContain("/bin");
    expect(roPaths).toContain("/lib");
    expect(roPaths).toContain("/etc");
    expect(roPaths).toContain("/dev");
    expect(roPaths).toContain("/proc");
    expect(roPaths).toContain(home);

    // RW paths obrigatórios
    const rwSection = result.slice(
      result.indexOf("--allow-rw"),
      result.indexOf("--"),
    );
    expect(rwSection).toContain("--allow-rw");
    expect(rwSection).toContain("/tmp");
    expect(rwSection).toContain("/run");
    expect(rwSection).toContain(proj);

    // Separador -- e comando no final
    expect(result).toContain("--");
    const sepIdx = result.lastIndexOf("--");
    expect(result[sepIdx + 1]).toBe("bash");
    expect(result[sepIdx + 2]).toBe("-c");
    expect(result[sepIdx + 3]).toBe("ls");
  });

  it("minAbi da config é repassado", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const cfg = makeConfig({ landlock: { minAbi: 5 } });

    const result = wrapWithLandlock(["--unshare-all"], ["echo", "x"], cfg, proj);
    const idx = result.indexOf("--min-abi");
    expect(result[idx + 1]).toBe("5");
  });
});

// ─── buildLandlockArgs: paths extras ──────────────────────────

describe("buildLandlockArgs — paths extras", () => {
  it("extraWritable viram --allow-rw", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const ext = mkdtempSync(join(tmpdir(), "sb-extw-"));
    fixtures.push(ext);
    const cfg = makeConfig({ filesystem: { extraWritable: [ext] } });

    const result = wrapWithLandlock(["--bind", proj, proj], ["echo", "x"], cfg, proj);
    expect(result).toContain("--allow-rw");
    const rwIdx = result.indexOf("--allow-rw");
    const rwSlice = result.slice(rwIdx);
    expect(rwSlice).toContain(ext);
  });

  it("extraReadonly viram --allow-ro", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const ext = mkdtempSync(join(tmpdir(), "sb-extr-"));
    fixtures.push(ext);
    const cfg = makeConfig({ filesystem: { extraReadonly: [ext] } });

    const result = wrapWithLandlock(["--bind", proj, proj], ["echo", "x"], cfg, proj);
    const roIdx = result.indexOf("--allow-ro");
    const roSlice = result.slice(roIdx, result.indexOf("--allow-rw"));
    expect(roSlice).toContain(ext);
  });

  it("cache dirs externos viram --allow-rw", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const ext = mkdtempSync(join(tmpdir(), "sb-cachex-"));
    fixtures.push(ext);
    const cfg = makeConfig({
      filesystem: { cacheDirs: { npm: ext, pip: "", clones: "" } },
    });

    const result = wrapWithLandlock(["--bind", proj, proj], ["echo", "x"], cfg, proj);
    const rwIdx = result.indexOf("--allow-rw");
    const rwSlice = result.slice(rwIdx);
    expect(rwSlice).toContain(ext);
  });

  it("SSH agent socket dir → --allow-rw", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const sockDir = mkdtempSync(join(tmpdir(), "sb-sock-"));
    fixtures.push(sockDir);
    const realSock = join(sockDir, "agent.123");
    writeFileSync(realSock, "");
    process.env.SSH_AUTH_SOCK = realSock;

    const cfg = makeConfig({ ssh: { mode: "agent" } });
    const result = wrapWithLandlock([], ["echo", "x"], cfg, proj);
    const rwIdx = result.indexOf("--allow-rw");
    const rwSlice = result.slice(rwIdx);
    expect(rwSlice).toContain(sockDir);
  });

  it("SSH mode mount/none → sem socket dir", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const cfg = makeConfig({ ssh: { mode: "none" } });

    const result = wrapWithLandlock([], ["echo", "x"], cfg, proj);
    const rwPaths = result.filter((_, i, arr) => arr[i - 1] === "--allow-rw");
    // Não deve conter dir de socket SSH
    expect(rwPaths.every((p) => !p.includes("ssh"))).toBe(true);
  });

  it("skills do agente vira --allow-ro se existir", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const skills = join(home, ".pi", "agent", "skills");
    mkdirSync(skills, { recursive: true });
    const proj = fixtureProj();

    const result = wrapWithLandlock([], ["echo", "x"], makeConfig(), proj);
    const roIdx = result.indexOf("--allow-ro");
    const roSlice = result.slice(roIdx, result.indexOf("--allow-rw"));
    expect(roSlice).toContain(skills);
  });

  it("pi docs dir vira --allow-ro se existir", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const piDir = join(home, ".local", "share", "pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "README.md"), "x");
    const proj = fixtureProj();

    const result = wrapWithLandlock([], ["echo", "x"], makeConfig(), proj);
    const roIdx = result.indexOf("--allow-ro");
    const roSlice = result.slice(roIdx, result.indexOf("--allow-rw"));
    expect(roSlice).toContain(piDir);
  });
});

// ─── buildBwrapArgs: mount do landlock-exec ───────────────────

describe("buildBwrapArgs — mount landlock-exec", () => {
  it("setLandlockExecPath → --ro-bind aparece nos args", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const cfg = makeConfig();
    setLandlockExecPath("/host/path/to/landlock-exec");

    const args = buildBwrapArgs(cfg, proj);
    const ro = args
      .map((v, i, arr) => (arr[i] === "--ro-bind" ? [arr[i + 1], arr[i + 2]] : null))
      .filter(Boolean);

    expect(ro).toContainEqual(["/host/path/to/landlock-exec", "/pi-landlock-exec"]);
  });

  it("landlock disabled na config → sem mount", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const cfg = makeConfig({ landlock: { enabled: false } });
    setLandlockExecPath("/host/path/to/landlock-exec");

    const args = buildBwrapArgs(cfg, proj);
    expect(args).not.toContain("/pi-landlock-exec");
  });

  it("setLandlockExecPath não chamado → sem mount", () => {
    process.env.HOME = fixtureHome();
    const proj = fixtureProj();
    const cfg = makeConfig();
    // Não chama setLandlockExecPath

    const args = buildBwrapArgs(cfg, proj);
    expect(args).not.toContain("/pi-landlock-exec");
  });
});
