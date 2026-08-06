/**
 * Testes do scan de arquivos sensíveis (security).
 *
 * Cobre matchSimpleGlob (casamento com wildcard) e findDangerousFiles
 * (scan recursivo que ignora .git/node_modules e degrada com cwd inválido).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchSimpleGlob, findDangerousFiles } from "../bwrap-executor";

const fixtures: string[] = [];

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

describe("findDangerousFiles", () => {
  it("encontra arquivos sensíveis recursivamente", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "id_rsa.pem"), "PRIV");
    writeFileSync(join(root, "safe.txt"), "ok");

    const found = findDangerousFiles(root, [".env", "*.pem"]);
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

    const found = findDangerousFiles(root, [".env"]);
    expect(found).toEqual([join(root, ".env")]);
  });

  it("sem padrões → vazio", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "x");
    expect(findDangerousFiles(root, [])).toEqual([]);
  });

  it("cwd inexistente → degrada sem negar nada", () => {
    expect(findDangerousFiles(join(tmpdir(), "nao-existe-xyz"), [".env"])).toEqual([]);
  });

  it("padrão wildcard múltiplo (ex: secrets/*)", () => {
    const root = fixture();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "api.key"), "x");
    writeFileSync(join(root, "api.key"), "x");
    // padrão sem * = igualdade exata de basename
    const found = findDangerousFiles(root, ["api.key"]);
    expect(found.sort()).toEqual(
      [join(root, "api.key"), join(root, "secrets", "api.key")].sort(),
    );
  });
});
