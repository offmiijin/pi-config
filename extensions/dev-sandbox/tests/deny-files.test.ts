/**
 * Testes do scan de arquivos sensíveis (security).
 *
 * Cobre matchSimpleGlob (casamento com wildcard) e findDangerousFiles
 * (scan recursivo que ignora .git/node_modules e degrada com cwd inválido).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchSimpleGlob, matchPathPattern, findDangerousFiles } from "../bwrap-executor";

// Diretórios cujo readdirSync deve falhar (simula EACCES/ENOENT no scan).
const state = vi.hoisted(() => ({ failOn: [] as string[], enoentOn: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      const p = args[0] as string;
      if (state.failOn.some((f) => p.startsWith(f))) {
        throw Object.assign(new Error(`EACCES: permission denied '${p}'`), { code: "EACCES" });
      }
      if (state.enoentOn.some((f) => p.startsWith(f))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${p}'`), { code: "ENOENT" });
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const fixtures: string[] = [];

beforeEach(() => {
  state.failOn = [];
  state.enoentOn = [];
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-deny-"));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
});

describe("matchSimpleGlob", () => {
  it("sem * = igualdade exata", () => {
    expect(matchSimpleGlob(".env", ".env")).toBe(true);
    expect(matchSimpleGlob("a.env", ".env")).toBe(false);
    expect(matchSimpleGlob("config", "config")).toBe(true);
    expect(matchSimpleGlob("config.json", "config")).toBe(false);
  });

  it("* sozinho casa qualquer nome", () => {
    expect(matchSimpleGlob("a.txt", "*")).toBe(true);
    expect(matchSimpleGlob("", "*")).toBe(true);
  });

  it("sufixo: *.pem", () => {
    expect(matchSimpleGlob("id_rsa.pem", "*.pem")).toBe(true);
    expect(matchSimpleGlob("id_rsa.pem.backup", "*.pem")).toBe(false);
  });

  it("prefixo: .env.*", () => {
    expect(matchSimpleGlob(".env.prod", ".env.*")).toBe(true);
    expect(matchSimpleGlob("a.env", ".env.*")).toBe(false);
  });

  it("prefixo e sufixo exigem tamanho mínimo", () => {
    expect(matchSimpleGlob("aXc", "a*c")).toBe(true);
    // wildcard casa vazio: "ac" = prefixo a + sufixo c
    expect(matchSimpleGlob("ac", "a*c")).toBe(true);
    expect(matchSimpleGlob("abc", "a*c")).toBe(true);
    expect(matchSimpleGlob("a", "a*c")).toBe(false);
    expect(matchSimpleGlob("c", "a*c")).toBe(false);
  });
});

describe("matchPathPattern", () => {
  it("casa path relativo por segmentos", () => {
    expect(matchPathPattern("secrets/api.key", "secrets/*")).toBe(true);
    expect(matchPathPattern("api.key", "secrets/*")).toBe(false);
    expect(matchPathPattern("secrets/x/api.key", "secrets/*")).toBe(false);
    expect(matchPathPattern("secrets/a.pem", "secrets/*.pem")).toBe(true);
    expect(matchPathPattern("secrets/a.pem.bak", "secrets/*.pem")).toBe(false);
  });

  it("* não atravessa segmento", () => {
    expect(matchPathPattern("a/b/c.key", "a/*.key")).toBe(false);
    expect(matchPathPattern("a/c.key", "a/*.key")).toBe(true);
  });
});

describe("findDangerousFiles", () => {
  it("padrão com path (secrets/*) casa arquivos aninhados", () => {
    const root = fixture();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "api.key"), "x");
    writeFileSync(join(root, "api.key"), "x");

    const found = findDangerousFiles(root, ["secrets/*"], []);
    expect(found).toEqual([join(root, "secrets", "api.key")]);
  });

  it("padrão basename continua casando em qualquer profundidade", () => {
    const root = fixture();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", ".env"), "x");
    const found = findDangerousFiles(root, [".env"], []);
    expect(found).toEqual([join(root, "a", "b", ".env")]);
  });

  it("encontra arquivos sensíveis recursivamente", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "id_rsa.pem"), "PRIV");
    writeFileSync(join(root, "safe.txt"), "ok");

    const found = findDangerousFiles(root, [".env", "*.pem"], []);
    expect(found.sort()).toEqual(
      [join(root, ".env"), join(root, "keys", "id_rsa.pem")].sort(),
    );
  });

  it("ignora .git e node_modules", () => {
    const root = fixture();
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, ".git", ".env"), "x");
    writeFileSync(join(root, "node_modules", ".env"), "x");
    writeFileSync(join(root, ".env"), "x");

    const found = findDangerousFiles(root, [".env"], []);
    expect(found).toEqual([join(root, ".env")]);
  });

  it("sem padrões → vazio", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "x");
    expect(findDangerousFiles(root, [], [])).toEqual([]);
  });

  it("cwd inexistente → degrada sem negar nada", () => {
    expect(findDangerousFiles(join(tmpdir(), "nao-existe-xyz"), [".env"], [])).toEqual([]);
  });

  it("diretório ilegível (EACCES) → bloqueia (fail-closed)", () => {
    const root = fixture();
    mkdirSync(join(root, "locked"), { recursive: true });
    writeFileSync(join(root, "locked", ".env"), "SECRET=1");
    state.failOn = [join(root, "locked")];
    try {
      // Fail-closed: dir sem permissão de listagem (r) ainda pode ter
      // arquivos acessíveis por nome dentro do sandbox (só precisa de x
      // no pai) — mascaramento por bind /dev/null não é garantido.
      expect(() => findDangerousFiles(root, [".env"], [])).toThrow(/denyFilePatterns/);
    } finally {
      state.failOn = [];
    }
  });

  it("diretório sob denyPath com EACCES → não bloqueia (tmpfs já mascara)", () => {
    const root = fixture();
    const denied = join(root, "dev", "mysql");
    mkdirSync(denied, { recursive: true });
    writeFileSync(join(denied, ".env"), "SECRET=1");
    // Diretório ilegível, mas coberto por denyPath — tmpfs mascara tudo
    state.failOn = [denied];
    try {
      // Não deve lançar: denyPath cobre o diretório
      const found = findDangerousFiles(root, [".env"], [denied]);
      // Arquivo sob denyPath não aparece nos resultados (tmpfs já o esconde)
      expect(found).toEqual([]);
    } finally {
      state.failOn = [];
    }
  });

  it("arquivo sensível sob denyPath não é reportado (tmpfs já mascara)", () => {
    const root = fixture();
    const denied = join(root, "secrets");
    mkdirSync(denied, { recursive: true });
    writeFileSync(join(denied, "api.key"), "x");
    writeFileSync(join(root, "outside.key"), "x");

    const found = findDangerousFiles(root, ["*.key"], [denied]);
    // Apenas arquivo fora do denyPath é reportado
    expect(found).toEqual([join(root, "outside.key")]);
  });

  it("denyPath fora do cwd não interfere no scan", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "x");
    // /sbin é denyPath típico — não afeta scan do workspace
    const found = findDangerousFiles(root, [".env"], ["/sbin", "/usr/sbin"]);
    expect(found).toEqual([join(root, ".env")]);
  });

  it("diretório removido durante o scan (ENOENT) → segue sem bloquear", () => {
    const root = fixture();
    mkdirSync(join(root, "gone"), { recursive: true });
    writeFileSync(join(root, "gone", ".env"), "x");
    state.enoentOn = [join(root, "gone")];
    try {
      // o subdir some entre listar e entrar — ENOENT é tolerado (nada a mascarar)
      expect(() => findDangerousFiles(root, [".env"], [])).not.toThrow();
    } finally {
      state.enoentOn = [];
    }
  });

  it("padrão wildcard múltiplo (ex: secrets/*)", () => {
    const root = fixture();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "api.key"), "x");
    writeFileSync(join(root, "api.key"), "x");
    // padrão sem * = igualdade exata de basename
    const found = findDangerousFiles(root, ["api.key"], []);
    expect(found.sort()).toEqual(
      [join(root, "api.key"), join(root, "secrets", "api.key")].sort(),
    );
  });
});
