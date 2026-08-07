/**
 * Testes de robustez do executor (spawn mockado).
 *
 * Cobre: abort já sinalizado antes do spawn (execInSandbox e bash-ops)
 * e degradação do seccomp com aviso quando o BPF não pode ser aberto.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (p: unknown, ...rest: unknown[]) => {
      if (String(p).includes("seccomp.bpf")) throw new Error("open failed (mock)");
      return (actual.openSync as (...a: unknown[]) => number)(p as string, ...rest);
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

describe("execInSandbox — degradação do seccomp", () => {
  it("BPF inaberto → aviso e execução sem --seccomp", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.seccomp.bpfPath = "/x/seccomp.bpf";

    const promise = execInSandbox(cfg, { command: ["echo", "x"], cwd: "/tmp" });
    child.emit("close", 0);
    const res = await promise;

    expect(res.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).not.toContain("--seccomp");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
