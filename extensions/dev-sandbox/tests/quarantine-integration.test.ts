/**
 * Testes de integração da quarentena com bwrap real (namespace aninhado).
 *
 * Pulados se o ambiente não suportar (mesmo critério do integration.test.ts):
 * bwrap ausente OU já dentro de um sandbox com seccomp (exit 159).
 *
 * Cobre as fronteiras de isolamento dos perfis fetch/quarantine:
 *   - fetch: não lê nem escreve no workspace
 *   - quarantine: não lê workspace, sem rede (curl falha)
 *   - quarantine: executa comandos normalmente no workdir
 *   - promote: copia artefato da quarentena de volta ao workspace
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execInProfile, resolveQuarantineDirs } from "../bwrap-executor";
import { promoteArtifact } from "../quarantine";
import { DEFAULT_CONFIG } from "../types";

const bwrapAvailable =
  existsSync("/usr/bin/bwrap") || existsSync("/usr/local/bin/bwrap") || existsSync("/bin/bwrap");

const fixtures: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-qint-"));
  fixtures.push(dir);
  return dir;
}

afterAll(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
});

// Config sem Landlock — o helper landlock-exec não é montado no ambiente de teste.
const config = structuredClone(DEFAULT_CONFIG);
config.landlock.enabled = false;

let nestedBwrapWorks = false;
if (bwrapAvailable) {
  try {
    const probe = await execInProfile(config, {
      command: ["echo", "probe"],
      cwd: resolveQuarantineDirs(config, fixture()).fetch,
    }, "fetch");
    nestedBwrapWorks = probe.exitCode === 0;
  } catch {
    nestedBwrapWorks = false;
  }
}

describe.skipIf(!nestedBwrapWorks)("integração quarentena com bwrap real", () => {
  it("fetch: não lê arquivo do workspace", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "sentinel.txt"), "MUST_NOT_LEAK");
    const dirs = resolveQuarantineDirs(config, cwd);

    const res = await execInProfile(config, {
      command: ["bash", "-lc", `cat "${join(cwd, "sentinel.txt")}"`],
      cwd: dirs.fetch,
    }, "fetch");
    expect(res.exitCode).not.toBe(0);
  });

  it("fetch: não escreve no workspace", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "sentinel.txt"), "MUST_NOT_LEAK");
    const dirs = resolveQuarantineDirs(config, cwd);

    const res = await execInProfile(config, {
      command: ["bash", "-lc", `echo hacked > "${join(cwd, "sentinel.txt")}"`],
      cwd: dirs.fetch,
    }, "fetch");
    expect(res.exitCode).not.toBe(0);
    expect(readFileSync(join(cwd, "sentinel.txt"), "utf8")).toBe("MUST_NOT_LEAK");
  });

  it("quarantine: não lê workspace e roda sem rede", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "sentinel.txt"), "MUST_NOT_LEAK");
    const dirs = resolveQuarantineDirs(config, cwd);

    // sem acesso ao workspace
    const read = await execInProfile(config, {
      command: ["bash", "-lc", `cat "${join(cwd, "sentinel.txt")}"`],
      cwd: dirs.runs,
    }, "quarantine");
    expect(read.exitCode).not.toBe(0);

    // sem rede — curl não resolve/estabelece conexão
    const net = await execInProfile(config, {
      command: ["bash", "-lc", "curl -m 3 -s https://example.com || echo CURLE_$?"],
      cwd: dirs.runs,
    }, "quarantine");
    expect(net.exitCode).toBe(0);
    expect(net.stdout.toString()).toContain("CURLE_");
  });

  it("quarantine: executa comandos normalmente no workdir persistente", async () => {
    const cwd = fixture();
    const dirs = resolveQuarantineDirs(config, cwd);

    const a = await execInProfile(config, {
      command: ["bash", "-lc", "echo build > out.txt"],
      cwd: dirs.runs,
    }, "quarantine");
    expect(a.exitCode).toBe(0);

    const b = await execInProfile(config, {
      command: ["bash", "-lc", "cat out.txt"],
      cwd: dirs.runs,
    }, "quarantine");
    expect(b.stdout.toString()).toContain("build");
  });

  it("promote: copia artefato da quarentena para o workspace", async () => {
    const cwd = fixture();
    const dirs = resolveQuarantineDirs(config, cwd);

    await execInProfile(config, {
      command: ["bash", "-lc", "echo dist > out.txt"],
      cwd: dirs.runs,
    }, "quarantine");

    const target = await promoteArtifact(config, cwd, "out.txt", "dist/out.txt");
    expect(target).toBe(join(cwd, "dist", "out.txt"));
    expect(readFileSync(target, "utf8")).toBe("dist");
  });
});
