/**
 * Testes de robustez do executor (spawn mockado).
 *
 * Cobre: abort já sinalizado antes do spawn (execInSandbox e bash-ops)
 * e degradação do seccomp com aviso quando o BPF não pode ser aberto.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cwd cujo scan de denyFilePatterns deve falhar (simula EACCES).
const state = vi.hoisted(() => ({ failScanCwd: null as string | null }));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // bpfPath é "/x/seccomp.bpf" (inexistente no host) — mocka como
    // existente para exercitar o caminho openSync-falha → degradação.
    existsSync: (p: unknown) => {
      if (String(p).includes("seccomp.bpf")) return true;
      return (actual.existsSync as (p: string) => boolean)(p as string);
    },
    openSync: (p: unknown, ...rest: unknown[]) => {
      if (String(p).includes("seccomp.bpf")) throw new Error("open failed (mock)");
      return (actual.openSync as (...a: unknown[]) => number)(p as string, ...rest);
    },
    readdirSync: (p: unknown, ...rest: unknown[]) => {
      if (state.failScanCwd !== null && String(p) === state.failScanCwd) {
        throw Object.assign(new Error(`EACCES: permission denied '${String(p)}'`), { code: "EACCES" });
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p as string, ...rest);
    },
  };
});

import { spawn } from "node:child_process";
import { execInSandbox } from "../bwrap-executor";
import { createBashOps } from "../tools/bash-ops";
import { DEFAULT_CONFIG } from "../types";

const spawnMock = vi.mocked(spawn);

/** Child process fake mínimo (event emitter + stdio). */
function fakeChild() {
  const events = new Map<string, Array<(...a: unknown[]) => void>>();
  const child: any = {
    pid: 4242,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: (e: string, cb: (...a: unknown[]) => void) => events.set(e, [...(events.get(e) ?? []), cb]) },
    stderr: { on: vi.fn() },
    on: (e: string, cb: (...a: unknown[]) => void) => events.set(e, [...(events.get(e) ?? []), cb]),
    emit: (e: string, ...args: unknown[]) => { for (const cb of events.get(e) ?? []) cb(...args); },
  };
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  state.failScanCwd = null;
});

describe("execInSandbox — abort pré-sinalizado", () => {
  it("não spawna processo e resolve aborted", async () => {
    const res = await execInSandbox(DEFAULT_CONFIG, {
      command: ["echo", "x"],
      cwd: "/tmp",
      signal: AbortSignal.abort(),
    });
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("bash-ops — abort pré-sinalizado", () => {
  it("não spawna processo e rejeita aborted", async () => {
    const ops = createBashOps(DEFAULT_CONFIG, "/tmp");
    await expect(
      ops.exec("echo x", "/tmp", {
        onData: () => {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("aborted");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("execInSandbox — scan de denyFilePatterns (fail-closed)", () => {
  it("scan falha → execução bloqueada (nada é executado)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sb-scan-"));
    try {
      state.failScanCwd = cwd;
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.filesystem.denyFilePatterns = [".env"];

      await expect(
        execInSandbox(cfg, { command: ["echo", "x"], cwd }),
      ).rejects.toThrow(/denyFilePatterns/);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      state.failScanCwd = null;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("execInSandbox — degradação do seccomp", () => {
  it("BPF inaberto → aviso e execução sem --seccomp", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.seccomp.bpfPath = "/x/seccomp.bpf";
    const cwd = mkdtempSync(join(tmpdir(), "sb-seccomp-"));

    try {
      const promise = execInSandbox(cfg, { command: ["echo", "x"], cwd });
      child.emit("close", 0);
      const res = await promise;

      expect(res.exitCode).toBe(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][1]).not.toContain("--seccomp");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
