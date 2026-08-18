/**
 * Testes de buildBwrapArgs — o coração do sandbox.
 *
 * Cobre: flags base, mounts read-only, isolamento de HOME, PATH sob HOME,
 * negociação de arquivos sensíveis (denyFilePatterns), SSH (agent/mount/none),
 * caches persistentes (cacheDirs), capabilities, whitelist de env vars
 * (SAFE_ENV_VARS) e não-uso de cache stale.
 *
 * Hermético: HOME e PATH são controlados via process.env; fixtures em tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapArgs } from "../bwrap-executor";
import { DEFAULT_CONFIG, type SandboxConfig, type SandboxFilesystemConfig, type SandboxProfilesConfig } from "../types";

// ─── Helpers ──────────────────────────────────────────────────

const fixtures: string[] = [];
const originalHome = process.env.HOME;
const originalPath = process.env.PATH || "";
const originalSshSock = process.env.SSH_AUTH_SOCK;
const originalEnv: Record<string, string | undefined> = {};

// cwd único por chamada — o cache de args bwrap é chaveado por (config+cwd);
// cwd repetido entre testes retornaria args stale do primeiro.
let cwdCounter = 0;
function uniqCwd(): string {
  cwdCounter++;
  return `/work/proj-${cwdCounter}`;
}

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sb-home-"));
  fixtures.push(home);
  return home;
}

function fixtureProj(): string {
  const proj = mkdtempSync(join(tmpdir(), "sb-proj-"));
  fixtures.push(proj);
  return proj;
}

/** Config com merge raso por seção (não muta DEFAULT_CONFIG). */
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
    worktree: { ...DEFAULT_CONFIG.worktree, ...(over.worktree ?? {}) },
  };
}

/** Pega os valores de um flag repetido (ex: todos os "--setenv" → valor). */
function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

/** --setenv como Map (key → value). */
function setenvMap(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === "--setenv") m.set(args[i + 1], args[i + 2]);
  }
  return m;
}

/** Pares (flag, valor) de binds --ro-bind. */
function roBindPairs(args: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === "--ro-bind") out.push([args[i + 1], args[i + 2]]);
  }
  return out;
}

beforeEach(() => {
  process.env.HOME = fixtureHome();
});

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalSshSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = originalSshSock;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── Flags base e filesystem ─────────────────────────────────

describe("buildBwrapArgs — flags base e mounts", () => {
  it("aplica flags base de isolamento", () => {
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    expect(args).toContain("--clearenv");
    expect(args).toContain("--proc");
    expect(args).toContain("--dev");
    // /tmp e /run como tmpfs efêmero
    expect(args).toContain("--tmpfs");
    const tmpfs = flagValues(args, "--tmpfs");
    expect(tmpfs).toContain("/tmp");
    expect(tmpfs).toContain("/run");
  });

  it("monta sistema read-only (/usr, /bin, /lib)", () => {
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const ro = roBindPairs(args);
    expect(ro).toContainEqual(["/usr", "/usr"]);
    expect(ro).toContainEqual(["/bin", "/bin"]);
    expect(ro).toContainEqual(["/lib", "/lib"]);
  });

  it("bind-monta o workspace read-write", () => {
    const cwd = uniqCwd();
    const args = buildBwrapArgs(makeConfig(), cwd);
    const binds = flagValues(args, "--bind");
    expect(binds).toContain(cwd);
  });

  it("monta raiz completa quando cwd é subdiretório do worktree", () => {
    const root = fixtureProj();
    const subdir = join(root, "src");
    mkdirSync(subdir);
    const args = buildBwrapArgs(makeConfig(), subdir, "normal", root);
    expect(flagValues(args, "--bind")).toContain(root);
    expect(flagValues(args, "--bind")).not.toContain(subdir);
  });

  it("cria HOME vazio antes das montagens", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const dirs = flagValues(args, "--dir");
    expect(dirs).toContain(home);
  });

  it("nega paths sensíveis com tmpfs vazio (pulando symlinks)", () => {
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const tmpfs = flagValues(args, "--tmpfs");
    for (const deny of DEFAULT_CONFIG.filesystem.denyPaths) {
      let isSymlink = false;
      try {
        isSymlink = lstatSync(deny).isSymbolicLink();
      } catch { /* não existe */ }
      if (isSymlink) {
        expect(tmpfs, `${deny} é symlink → deve ser pulado`).not.toContain(deny);
      } else {
        expect(tmpfs).toContain(deny);
      }
    }
  });

  it("denyPaths: pula symlinks (ex: /usr/sbin -> bin) para não mascarar o destino", () => {
    const base = mkdtempSync(join(tmpdir(), "sb-deny-"));
    fixtures.push(base);
    const realSbin = join(base, "real-sbin");
    mkdirSync(realSbin);
    const sbinLink = join(base, "sbin-link");
    symlinkSync(realSbin, sbinLink);

    const args = buildBwrapArgs(
      makeConfig({ filesystem: { denyPaths: [sbinLink, realSbin] } }),
      uniqCwd(),
    );
    const tmpfs = flagValues(args, "--tmpfs");
    expect(tmpfs).toContain(realSbin);
    expect(tmpfs).not.toContain(sbinLink);
  });

  it("remove capabilities padrão (18)", () => {
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    expect(flagValues(args, "--cap-drop")).toHaveLength(18);
    expect(flagValues(args, "--cap-drop")).toContain("CAP_SYS_ADMIN");
    expect(flagValues(args, "--cap-drop")).toContain("CAP_SYS_PTRACE");
    // Mantidas
    expect(flagValues(args, "--cap-drop")).not.toContain("CAP_SYS_NICE");
    expect(flagValues(args, "--cap-drop")).not.toContain("CAP_SYS_RESOURCE");
  });

  it("só compartilha rede com internet.enabled", () => {
    expect(buildBwrapArgs(makeConfig(), "/w/p")).toContain("--share-net");
    expect(
      buildBwrapArgs(makeConfig({ internet: { enabled: false } }), "/w/p"),
    ).not.toContain("--share-net");
  });

  it("respeita rede e SSH do perfil normal", () => {
    const cfg = makeConfig({ profiles: { normal: { network: false, ssh: "none" } } });
    const args = buildBwrapArgs(cfg, "/w/profile-normal");
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("SSH_AUTH_SOCK");
  });

  it("monta skills do agente (ro)", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const skills = join(home, ".pi", "agent", "skills");
    mkdirSync(skills, { recursive: true });
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    expect(roBindPairs(args)).toContainEqual([skills, skills]);
  });

  it("monta .gitconfig (ro) para commits", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".gitconfig"), "[user]\n");
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    expect(roBindPairs(args)).toContainEqual([join(home, ".gitconfig"), join(home, ".gitconfig")]);
  });

  it("monta documentação do pi (versão mais alta via mise)", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const piBase = join(home, ".local", "share", "mise", "installs", "pi");
    mkdirSync(join(piBase, "0.81.0"), { recursive: true });
    mkdirSync(join(piBase, "0.82.1"), { recursive: true });
    writeFileSync(join(piBase, "0.81.0", "README.md"), "x");
    writeFileSync(join(piBase, "0.82.1", "README.md"), "x");
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const ro = roBindPairs(args);
    expect(ro).toContainEqual([join(piBase, "0.82.1"), join(piBase, "0.82.1")]);
    expect(ro).not.toContainEqual([join(piBase, "0.81.0"), join(piBase, "0.81.0")]);
  });

  it("monta documentação do pi (fallback ~/.local/share/pi)", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const piDir = join(home, ".local", "share", "pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "README.md"), "x");
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    expect(roBindPairs(args)).toContainEqual([piDir, piDir]);
  });
});

// ─── PATH sob HOME ────────────────────────────────────────────

describe("buildBwrapArgs — PATH sob HOME", () => {
  it("monta somente diretórios necessários do PATH sob HOME", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    process.env.PATH = `${localBin}:${originalPath}`;
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const ro = roBindPairs(args);
    // Monta bin exato — não expõe ~/.local inteiro.
    expect(ro).toContainEqual([localBin, localBin]);
    expect(ro).not.toContainEqual([join(home, ".local"), join(home, ".local")]);
  });

  it("PATH sempre inclui /usr/local/bin, /usr/bin e /bin", () => {
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const env = setenvMap(args);
    const path = env.get("PATH") || "";
    expect(path.split(":")).toEqual(
      expect.arrayContaining(["/usr/local/bin", "/usr/bin", "/bin"]),
    );
  });
});

// ─── Arquivos sensíveis (denyFilePatterns) ────────────────────

describe("buildBwrapArgs — denyFilePatterns", () => {
  it("substitui arquivos sensíveis por /dev/null (ro)", () => {
    const proj = fixtureProj();
    writeFileSync(join(proj, ".env"), "SECRET=1");
    mkdirSync(join(proj, "keys"), { recursive: true });
    writeFileSync(join(proj, "keys", "id_rsa.pem"), "PRIV");
    writeFileSync(join(proj, "safe.txt"), "ok");
    const args = buildBwrapArgs(makeConfig(), proj);
    const ro = roBindPairs(args);
    expect(ro).toContainEqual(["/dev/null", join(proj, ".env")]);
    expect(ro).toContainEqual(["/dev/null", join(proj, "keys", "id_rsa.pem")]);
    expect(ro).not.toContainEqual(["/dev/null", join(proj, "safe.txt")]);
  });

  it("ignora .git e node_modules no scan", () => {
    const proj = fixtureProj();
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, "node_modules"), { recursive: true });
    writeFileSync(join(proj, ".git", "config.env"), "x");
    writeFileSync(join(proj, "node_modules", "lib.env"), "x");
    const args = buildBwrapArgs(makeConfig(), proj);
    const ro = roBindPairs(args);
    expect(ro).not.toContainEqual(["/dev/null", join(proj, ".git", "config.env")]);
    expect(ro).not.toContainEqual(["/dev/null", join(proj, "node_modules", "lib.env")]);
  });

  it("sem padrões não adiciona binds de /dev/null", () => {
    const proj = fixtureProj();
    writeFileSync(join(proj, ".env"), "x");
    const args = buildBwrapArgs(makeConfig({ filesystem: { denyFilePatterns: [] } }), proj);
    expect(roBindPairs(args).filter(([src]) => src === "/dev/null")).toHaveLength(0);
  });

  it("re-scanneia a cada chamada: arquivo sensível criado depois é mascarado", () => {
    const proj = fixtureProj();
    const config = makeConfig();
    const first = buildBwrapArgs(config, proj);
    expect(roBindPairs(first).filter(([src]) => src === "/dev/null")).toHaveLength(0);

    writeFileSync(join(proj, ".env"), "SECRET=1");
    const second = buildBwrapArgs(config, proj);
    expect(roBindPairs(second)).toContainEqual(["/dev/null", join(proj, ".env")]);
  });

  it("bind de deny vence bind read-write de extraWritable", () => {
    const proj = fixtureProj();
    writeFileSync(join(proj, ".env"), "SECRET=1");
    const args = buildBwrapArgs(
      makeConfig({ filesystem: { extraWritable: [proj] } }),
      proj,
    );
    // deny (/dev/null) vem DEPOIS do bind rw do diretório → prevalece
    const denyIdx = args.indexOf("/dev/null");
    const bindIdx = args.lastIndexOf("--bind");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(denyIdx).toBeGreaterThan(bindIdx);
  });
});

// ─── SSH ──────────────────────────────────────────────────────

describe("buildBwrapArgs — SSH", () => {
  it("modo agent: bind do socket real + symlink + SSH_AUTH_SOCK original", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    const sockDir = mkdtempSync(join(tmpdir(), "sb-sock-"));
    fixtures.push(sockDir);
    const realSock = join(sockDir, "agent.123");
    writeFileSync(realSock, "");
    const sockLink = join(sockDir, "link");
    symlinkSync(realSock, sockLink);
    process.env.SSH_AUTH_SOCK = sockLink;

    const args = buildBwrapArgs(makeConfig(), uniqCwd());

    // Cria dir do socket
    expect(flagValues(args, "--dir")).toContain(sockDir);
    // Bind do socket REAL
    expect(args).toContainEqual(realSock);
    const binds = flagValues(args, "--bind");
    expect(binds).toContain(realSock);
    // Symlink recriado (path original → real)
    const sym = args.indexOf("--symlink");
    expect(sym).toBeGreaterThanOrEqual(0);
    expect(args[sym + 1]).toBe(realSock);
    expect(args[sym + 2]).toBe(sockLink);
    // Env aponta para o path original (o que o ssh-client espera)
    expect(setenvMap(args).get("SSH_AUTH_SOCK")).toBe(sockLink);
  });

  it("modo agent: monta known_hosts e config read-only", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    delete process.env.SSH_AUTH_SOCK;
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "known_hosts"), "host1");
    writeFileSync(join(home, ".ssh", "config"), "Host *");
    const args = buildBwrapArgs(makeConfig(), uniqCwd());
    const ro = roBindPairs(args);
    expect(ro).toContainEqual([join(home, ".ssh", "known_hosts"), join(home, ".ssh", "known_hosts")]);
    expect(ro).toContainEqual([join(home, ".ssh", "config"), join(home, ".ssh", "config")]);
  });

  it("modo mount: monta ~/.ssh inteiro read-only (legado)", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIV");
    const args = buildBwrapArgs(makeConfig({ ssh: { mode: "mount" } }), uniqCwd());
    expect(roBindPairs(args)).toContainEqual([join(home, ".ssh"), join(home, ".ssh")]);
  });

  it("modo none: nada de SSH é montado", () => {
    const home = fixtureHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIV");
    writeFileSync(join(home, ".ssh", "known_hosts"), "h");
    const args = buildBwrapArgs(makeConfig({ ssh: { mode: "none" } }), uniqCwd());
    const ro = roBindPairs(args);
    expect(ro).not.toContainEqual([join(home, ".ssh"), join(home, ".ssh")]);
    expect(ro).not.toContainEqual([join(home, ".ssh", "known_hosts"), join(home, ".ssh", "known_hosts")]);
    expect(setenvMap(args).has("SSH_AUTH_SOCK")).toBe(false);
  });
});

// ─── Caches persistentes (cacheDirs) ──────────────────────────

describe("buildBwrapArgs — cacheDirs", () => {
  it("injetar envs padrão apontando para .sandbox-cache/", () => {
    const cwd = uniqCwd();
    const args = buildBwrapArgs(makeConfig(), cwd);
    const env = setenvMap(args);
    expect(env.get("NPM_CONFIG_CACHE")).toBe(`${cwd}/.sandbox-cache/npm`);
    expect(env.get("PIP_CACHE_DIR")).toBe(`${cwd}/.sandbox-cache/pip`);
    expect(env.get("SANDBOX_CLONE_DIR")).toBe(`${cwd}/.sandbox-cache/clones`);
  });

  it("caminho externo custom: cria + bind read-write", () => {
    const ext = mkdtempSync(join(tmpdir(), "sb-cache-"));
    fixtures.push(ext);
    const args = buildBwrapArgs(
      makeConfig({ filesystem: { cacheDirs: { npm: ext, pip: "", clones: "" } } }),
      uniqCwd(),
    );
    expect(setenvMap(args).get("NPM_CONFIG_CACHE")).toBe(ext);
    // --dir + --bind para persistência fora do workspace
    expect(flagValues(args, "--dir")).toContain(ext);
    expect(flagValues(args, "--bind")).toContain(ext);
  });

  it("caminho externo já coberto por extraWritable: sem bind duplicado", () => {
    const ext = mkdtempSync(join(tmpdir(), "sb-cache-"));
    fixtures.push(ext);
    const args = buildBwrapArgs(
      makeConfig({
        filesystem: {
          extraWritable: [ext],
          cacheDirs: { npm: ext, pip: "", clones: "" },
        },
      }),
      uniqCwd(),
    );
    // extraWritable adiciona 1 bind; cache não duplica (sem --dir próprio)
    expect(flagValues(args, "--bind").filter((v) => v === ext)).toHaveLength(1);
    expect(flagValues(args, "--dir")).not.toContain(ext);
  });

  it("perfil normal mascara runs, mas mantém fetch visível no worktree", () => {
    const cwd = fixtureProj();
    const args = buildBwrapArgs(makeConfig(), cwd);
    const tmpfs = flagValues(args, "--tmpfs");
    expect(tmpfs).toContain(join(cwd, ".sandbox-cache", "runs"));
    expect(tmpfs).not.toContain(join(cwd, ".sandbox-cache", "fetch"));
  });
});

// ─── Whitelist de env vars (SEGURANÇA) ────────────────────────

describe("buildBwrapArgs — SAFE_ENV_VARS whitelist", () => {
  const LEAKS: Array<[string, string]> = [
    ["AWS_SECRET_ACCESS_KEY", "leak-aws"],
    ["GITHUB_TOKEN", "leak-gh"],
    ["NPM_TOKEN", "leak-npm"],
    ["DATABASE_URL", "leak-db"],
    ["OPENAI_API_KEY", "leak-openai"],
    ["ANTHROPIC_API_KEY", "leak-anthropic"],
    ["MYAPP_PASSWORD", "leak-pass"],
  ];

  it("nunca repassa secrets para dentro do sandbox", () => {
    for (const [k, v] of LEAKS) {
      process.env[k] = v;
      originalEnv[k] = process.env[k];
    }
    const env = setenvMap(buildBwrapArgs(makeConfig(), uniqCwd()));
    for (const [k] of LEAKS) {
      expect(env.has(k), `${k} não deveria passar`).toBe(false);
    }
  });

  it("repassa vars seguras de desenvolvimento", () => {
    process.env.EDITOR = "vim";
    process.env.TERM = "xterm-256color";
    originalEnv.EDITOR = process.env.EDITOR;
    originalEnv.TERM = process.env.TERM;
    const env = setenvMap(buildBwrapArgs(makeConfig(), uniqCwd()));
    expect(env.get("EDITOR")).toBe("vim");
    expect(env.get("TERM")).toBe("xterm-256color");
    expect(env.get("HOME")).toBe(process.env.HOME);
    expect(env.get("USER")).toBeDefined();
  });
});

// ─── Cache de argumentos ──────────────────────────────────────

describe("buildBwrapArgs — cache", () => {
  it("config diferente → args diferentes (sem stale cache)", () => {
    const a = buildBwrapArgs(makeConfig(), uniqCwd());
    const b = buildBwrapArgs(
      makeConfig({ filesystem: { denyPaths: ["/proc"] } }),
      uniqCwd(),
    );
    // /proc negado → --tmpfs /proc extra em b (base usa --proc /proc)
    const tmpfsA = flagValues(a, "--tmpfs").filter((v) => v === "/proc");
    const tmpfsB = flagValues(b, "--tmpfs").filter((v) => v === "/proc");
    expect(tmpfsA).toHaveLength(0);
    expect(tmpfsB).toHaveLength(1);
  });

  it("mudança de HOME invalida o cache (args não ficam stale)", () => {
    const homeA = fixtureHome();
    const homeB = fixtureHome();
    mkdirSync(join(homeA, ".ssh"), { recursive: true });
    mkdirSync(join(homeB, ".ssh"), { recursive: true });
    const cfg = makeConfig({ ssh: { mode: "mount" } });
    const cwd = uniqCwd();

    process.env.HOME = homeA;
    const argsA = buildBwrapArgs(cfg, cwd);
    process.env.HOME = homeB;
    const argsB = buildBwrapArgs(cfg, cwd);

    expect(roBindPairs(argsA)).toContainEqual([join(homeA, ".ssh"), join(homeA, ".ssh")]);
    expect(roBindPairs(argsB)).toContainEqual([join(homeB, ".ssh"), join(homeB, ".ssh")]);
  });

  it("mudança de SSH_AUTH_SOCK invalida o cache", () => {
    const sockDirA = mkdtempSync(join(tmpdir(), "sb-sockA-"));
    fixtures.push(sockDirA);
    const sockA = join(sockDirA, "agent.1");
    writeFileSync(sockA, "");
    const sockDirB = mkdtempSync(join(tmpdir(), "sb-sockB-"));
    fixtures.push(sockDirB);
    const sockB = join(sockDirB, "agent.2");
    writeFileSync(sockB, "");
    const cwd = uniqCwd();

    process.env.SSH_AUTH_SOCK = sockA;
    const argsA = buildBwrapArgs(makeConfig(), cwd);
    process.env.SSH_AUTH_SOCK = sockB;
    const argsB = buildBwrapArgs(makeConfig(), cwd);

    expect(flagValues(argsA, "--bind")).toContain(sockA);
    expect(flagValues(argsB, "--bind")).toContain(sockB);
  });

  it("perfil fetch monta o dir de fetch real (sem path aninhado)", () => {
    const cwd = fixtureProj();
    const args = buildBwrapArgs(makeConfig(), cwd, "fetch");
    const binds = flagValues(args, "--bind");
    expect(binds).toContain(join(cwd, ".sandbox-cache", "fetch"));
    // Regressão: cwd de quarentena como base gerava bind aninhado
    // (<fetch>/.sandbox-cache/fetch) — o dir real nunca era montado.
    for (const b of binds) {
      expect(b.includes(join(".sandbox-cache", "fetch", ".sandbox-cache"))).toBe(false);
    }
  });

  it("perfil quarantine monta o dir de runs real (sem path aninhado)", () => {
    const cwd = fixtureProj();
    const args = buildBwrapArgs(makeConfig(), cwd, "quarantine");
    const binds = flagValues(args, "--bind");
    expect(binds).toContain(join(cwd, ".sandbox-cache", "runs"));
    for (const b of binds) {
      expect(b.includes(join(".sandbox-cache", "runs", ".sandbox-cache"))).toBe(false);
    }
  });
});
