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
import { execInSandbox, setLandlockExecPath, probeLandlockAbi } from "../bwrap-executor";
import { createBashOps } from "../tools/bash-ops";
import { DEFAULT_CONFIG, type SandboxConfig } from "../types";

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

// Config sem Landlock para probe e testes bwrap (helper não montado)
const noLandlockConfig = structuredClone(DEFAULT_CONFIG);
noLandlockConfig.landlock.enabled = false;

let nestedBwrapWorks = false;
if (bwrapAvailable) {
  try {
    const probe = await execInSandbox(noLandlockConfig, {
      command: ["echo", "probe"], cwd: "/tmp",
    });
    nestedBwrapWorks = probe.exitCode === 0;
  } catch {
    nestedBwrapWorks = false;
  }
}

describe.skipIf(!nestedBwrapWorks)("integração com bwrap real", () => {
  const config = noLandlockConfig;

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

// ─── Integração Landlock ─────────────────────────────────────

const landlockExecPath = join(__dirname, "..", "gen-seccomp", "target", "release", "landlock-exec");
const landlockAvailable =
  existsSync(landlockExecPath) && probeLandlockAbi(landlockExecPath) !== null;

if (landlockAvailable) {
  setLandlockExecPath(landlockExecPath);
}

const landlockConfig: SandboxConfig = structuredClone(DEFAULT_CONFIG);
// Landlock já vem habilitado por padrão — usamos a config completa.

describe.skipIf(!nestedBwrapWorks || !landlockAvailable)("integração Landlock", () => {
  it("comando simples executa com Landlock ativo", async () => {
    const cwd = fixture();
    const res = await execInSandbox(landlockConfig, { command: ["echo", "ok"], cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("ok\n");
  });

  it("leitura/escrita no workspace funciona", async () => {
    const cwd = fixture();
    const res = await execInSandbox(landlockConfig, {
      command: ["bash", "-c", "echo data > test.txt && cat test.txt"],
      cwd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("data\n");
    expect(existsSync(join(cwd, "test.txt"))).toBe(true);
  });

  it("/sys inacessível (fora da allowlist)", async () => {
    const cwd = fixture();
    const res = await execInSandbox(landlockConfig, {
      command: ["cat", "/sys/kernel/version"],
      cwd,
    });
    expect(res.exitCode).not.toBe(0);
  });

  it("/usr é read-only (escrita negada)", async () => {
    const cwd = fixture();
    const res = await execInSandbox(landlockConfig, {
      command: ["touch", "/usr/landlock-write-test"],
      cwd,
    });
    expect(res.exitCode).not.toBe(0);
  });

  it("arquivo em /tmp pode ser criado e lido", async () => {
    const cwd = fixture();
    const res = await execInSandbox(landlockConfig, {
      command: ["bash", "-c", "echo tmpdata > /tmp/ltest && cat /tmp/ltest"],
      cwd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("tmpdata\n");
  });

  it("mv (rename) entre diretórios funciona (REFER)", async () => {
    const cwd = fixture();
    const res = await execInSandbox(landlockConfig, {
      command: ["bash", "-c", "mkdir a b && echo x > a/f && mv a/f b/f && cat b/f"],
      cwd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("x\n");
  });

  it(".env do workspace é mascarado via bwrap (Landlock não interfere)", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, ".env"), "SECRET=1");
    const res = await execInSandbox(landlockConfig, {
      command: ["cat", ".env"],
      cwd,
    });
    // denyFilePatterns do bwrap mascara .env como /dev/null
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("");
  });

  it("comando em filho herda Landlock", async () => {
    const cwd = fixture();
    // bash -c spawna um child; Landlock restringe o child também
    const res = await execInSandbox(landlockConfig, {
      command: ["bash", "-c", "cat /sys/kernel/version 2>&1 || true"],
      cwd,
    });
    expect(res.exitCode).toBe(0);
    // Deve conter erro de acesso negado, não o conteúdo do arquivo
    const out = res.stdout.toString();
    expect(out).toMatch(/denied|No such file|cannot open/i);
  });
});
