/**
 * Testes de integração com bwrap real (namespace aninhado).
 *
 * Pulados automaticamente se o ambiente não suportar bwrap aninhado:
 * - bwrap ausente, OU
 * - já dentro de um sandbox com seccomp (SIGSYS em mount/pivot_root —
 *   exit 159). Rodam no host ou em CI sem sandbox externo.
 *
 * Cobre: execução básica, stdin, read-only de /usr, mascaramento de .env,
 * efemeridade do /tmp entre namespaces, env custom no bash e timeout.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execInSandbox } from "../bwrap-executor";
import { createBashOps } from "../tools/bash-ops";
import { DEFAULT_CONFIG } from "../types";

const bwrapAvailable =
  existsSync("/usr/bin/bwrap") || existsSync("/usr/local/bin/bwrap") || existsSync("/bin/bwrap");

const fixtures: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-int-"));
  fixtures.push(dir);
  return dir;
}

afterAll(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
});

// Probe: bwrap aninhado só funciona fora de sandbox com seccomp (SIGSYS = 159)
let nestedBwrapWorks = false;
if (bwrapAvailable) {
  try {
    const probe = await execInSandbox(DEFAULT_CONFIG, {
      command: ["echo", "probe"], cwd: "/tmp",
    });
    nestedBwrapWorks = probe.exitCode === 0;
  } catch {
    nestedBwrapWorks = false;
  }
}

describe.skipIf(!nestedBwrapWorks)("integração com bwrap real", () => {
  const config = DEFAULT_CONFIG;

  it("executa comando e captura stdout", async () => {
    const cwd = fixture();
    const res = await execInSandbox(config, { command: ["echo", "oi"], cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("oi\n");
  });

  it("repassa stdin", async () => {
    const cwd = fixture();
    const res = await execInSandbox(config, {
      command: ["bash", "-c", "cat"], cwd, stdin: "dados-pelo-stdin",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("dados-pelo-stdin");
  });

  it("/usr é read-only (escrita falha)", async () => {
    const cwd = fixture();
    const res = await execInSandbox(config, {
      command: ["touch", "/usr/sb-write-test-xyz"], cwd,
    });
    expect(res.exitCode).not.toBe(0);
  });

  it(".env do workspace é mascarado como /dev/null", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, ".env"), "TOPSECRET=1");
    const res = await execInSandbox(config, { command: ["cat", ".env"], cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("");
  });

  it("/tmp é efêmero entre namespaces", async () => {
    const cwd = fixture();
    const w = await execInSandbox(config, {
      command: ["bash", "-c", "echo x > /tmp/sb-mark && cat /tmp/sb-mark"], cwd,
    });
    expect(w.stdout.toString()).toBe("x\n");
    const r = await execInSandbox(config, {
      command: ["cat", "/tmp/sb-mark"], cwd,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it("preserva bytes binários no stdout", async () => {
    const cwd = fixture();
    const res = await execInSandbox(config, {
      command: ["bash", "-c", "printf '\\377\\376\\000A'"], cwd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.equals(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toBe(true);
  });

  it("bash-ops: env custom visível", async () => {
    const cwd = fixture();
    const chunks: Buffer[] = [];
    const { exitCode } = await createBashOps(config, cwd).exec(
      "echo $FOO",
      cwd,
      { onData: (d: Buffer) => chunks.push(d), env: { FOO: "bar" } },
    );
    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toContain("bar");
  });

  it("timeout mata o processo e marca timedOut", async () => {
    const cwd = fixture();
    const res = await execInSandbox(config, {
      command: ["sleep", "5"], cwd, timeout: 1,
    });
    expect(res.timedOut).toBe(true);
  }, 10_000);
});
