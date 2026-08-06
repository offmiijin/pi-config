/**
 * Testes do tool grep (ripgrep via sandbox).
 *
 * Cobre: construção dos argumentos rg (literal, ignore-case, contexto, glob,
 * limite), tratamento de exit codes (0/1 ok, 2 erro), validação de pattern,
 * estado não inicializado e aviso de limite atingido.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../bwrap-executor", () => ({ execInSandbox: vi.fn() }));

import { createGrepTool, setGrepConfig } from "../tools/grep";
import { execInSandbox } from "../bwrap-executor";
import { DEFAULT_CONFIG } from "../types";

const execMock = vi.mocked(execInSandbox);

function makeTool() {
  return createGrepTool("/work/proj");
}

function run(params: Record<string, unknown>, ctx: { cwd: string } = { cwd: "/work/proj" }) {
  return makeTool().execute("id", params, undefined, () => {}, ctx);
}

beforeEach(() => {
  execMock.mockReset();
  setGrepConfig(DEFAULT_CONFIG);
});

describe("grep — validação e estado", () => {
  it("pattern vazio → erro", async () => {
    const res = await run({ pattern: "" });
    expect(res.content[0].text).toContain("Error: pattern is required");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("sandbox não inicializado → erro", async () => {
    setGrepConfig(null as unknown as typeof DEFAULT_CONFIG);
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).toContain("Error: sandbox not initialized");
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("grep — construção de rgArgs", () => {
  it("flags base + default limit 100 + path '.'", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "foo" });
    const [, call] = execMock.mock.calls[0];
    const cmd = call.command as string[];
    expect(cmd[0]).toBe("rg");
    for (const flag of ["--no-heading", "--with-filename", "--line-number", "--no-messages", "--color", "never"]) {
      expect(cmd).toContain(flag);
    }
    expect(cmd).toContain("--max-count");
    expect(cmd[cmd.indexOf("--max-count") + 1]).toBe("100");
    expect(cmd[cmd.length - 1]).toBe(".");
    expect(cmd[cmd.length - 2]).toBe("foo");
  });

  it("literal → --fixed-strings", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "a.b", literal: true });
    expect(execMock.mock.calls[0][1].command).toContain("--fixed-strings");
  });

  it("ignoreCase → --ignore-case", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "x", ignoreCase: true });
    expect(execMock.mock.calls[0][1].command).toContain("--ignore-case");
  });

  it("context → -C N", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "x", context: 3 });
    const cmd = execMock.mock.calls[0][1].command;
    expect(cmd).toContain("-C");
    expect(cmd[cmd.indexOf("-C") + 1]).toBe("3");
  });

  it("glob → --glob", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "x", glob: "*.ts" });
    const cmd = execMock.mock.calls[0][1].command;
    expect(cmd).toContain("--glob");
    expect(cmd[cmd.indexOf("--glob") + 1]).toBe("*.ts");
  });

  it("limit custom → --max-count N", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "x", limit: 5 });
    const cmd = execMock.mock.calls[0][1].command;
    expect(cmd[cmd.indexOf("--max-count") + 1]).toBe("5");
  });

  it("path param vira último argumento", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "x", path: "src" });
    const cmd = execMock.mock.calls[0][1].command;
    expect(cmd[cmd.length - 1]).toBe("src");
    expect(execMock.mock.calls[0][1].cwd).toBe("/work/proj");
  });

  it("usa ctx.cwd como cwd da busca", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await run({ pattern: "x" }, { cwd: "/outro/dir" });
    expect(execMock.mock.calls[0][1].cwd).toBe("/outro/dir");
  });
});

describe("grep — exit codes e saída", () => {
  it("exit 0 com matches → texto", async () => {
    execMock.mockResolvedValue({ stdout: "src/a.ts:1:foo\n", stderr: "", exitCode: 0 });
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toBe("src/a.ts:1:foo");
  });

  it("exit 1 (sem matches) → No matches found", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toBe("No matches found");
  });

  it("exit 2 (erro) → mensagem de erro com stderr", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "rg: permission denied", exitCode: 2 });
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toContain("rg: permission denied");
  });

  it("exit code inesperado → erro genérico", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 3 });
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toContain("exit code 3");
  });

  it("limite atingido → aviso [N matches limit reached]", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `f${i}.ts:1:x`);
    execMock.mockResolvedValue({ stdout: lines.join("\n"), stderr: "", exitCode: 0 });
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).toContain("[100 matches limit reached]");
    expect(res.details?.matchLimitReached).toBe(100);
  });

  it("abaixo do limite → sem aviso", async () => {
    execMock.mockResolvedValue({ stdout: "a.ts:1:x\nb.ts:1:x\n", stderr: "", exitCode: 0 });
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).not.toContain("matches limit reached");
  });
});
