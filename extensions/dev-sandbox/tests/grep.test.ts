/**
 * Testes do tool grep (ripgrep via sandbox).
 *
 * Cobre: construção do comando bash (pipefail + head p/ limite global),
 * passagem dos args do rg via "$@" (sem shell injection), exit codes
 * (0/1/2), validação de pattern e aviso de limite atingido.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../bwrap-executor", () => ({ execInSandbox: vi.fn() }));

import { createGrepTool } from "../tools/grep";
import { execInSandbox } from "../bwrap-executor";
import { DEFAULT_CONFIG } from "../types";

const execMock = vi.mocked(execInSandbox);

function makeTool() {
  return createGrepTool("/work/proj", DEFAULT_CONFIG);
}

function run(params: {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
}) {
  return makeTool().execute("id", params, undefined, () => {});
}

/** Extrai os args do rg do comando ["bash","-c",script,"_", ...rgArgs]. */
function rgArgsOf(call: { command: unknown }): string[] {
  return (call.command as string[]).slice(4);
}

/** Resultado mockado com stdout em Buffer (contrato real do executor). */
function mockResult(stdout: string, exitCode = 0) {
  return { stdout: Buffer.from(stdout), stderr: "", exitCode, timedOut: false, aborted: false };
}

beforeEach(() => {
  execMock.mockReset();
});

describe("grep — validação", () => {
  it("pattern vazio → erro", async () => {
    const res = await run({ pattern: "" });
    expect(res.content[0].text).toContain("Error: pattern is required");
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("grep — construção do comando", () => {
  it("bash com pipefail e head para limite global; args via \$@", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "foo" });
    const [, call] = execMock.mock.calls[0];
    const cmd = call.command as string[];
    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    const script = cmd[2] as string;
    expect(script).toContain("set -o pipefail");
    expect(script).toContain('rg "$@"');
    expect(script).toContain("head -n 101"); // limit default 100 + 1

    const rg = rgArgsOf(call);
    for (const flag of ["--no-heading", "--with-filename", "--line-number", "--no-messages", "--color", "never"]) {
      expect(rg).toContain(flag);
    }
    // sem --max-count por arquivo (limite agora é global via head)
    expect(rg).not.toContain("--max-count");
    expect(rg[rg.length - 1]).toBe(".");
    expect(rg[rg.length - 2]).toBe("foo");
  });

  it("literal → --fixed-strings", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "a.b", literal: true });
    expect(rgArgsOf(execMock.mock.calls[0][1])).toContain("--fixed-strings");
  });

  it("ignoreCase → --ignore-case", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", ignoreCase: true });
    expect(rgArgsOf(execMock.mock.calls[0][1])).toContain("--ignore-case");
  });

  it("context → -C N", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", context: 3 });
    const rg = rgArgsOf(execMock.mock.calls[0][1]);
    expect(rg).toContain("-C");
    expect(rg[rg.indexOf("-C") + 1]).toBe("3");
  });

  it("glob → --glob", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", glob: "*.ts" });
    const rg = rgArgsOf(execMock.mock.calls[0][1]);
    expect(rg).toContain("--glob");
    expect(rg[rg.indexOf("--glob") + 1]).toBe("*.ts");
  });

  it("limit custom → head -n N+1", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", limit: 5 });
    const script = (execMock.mock.calls[0][1].command as string[])[2] as string;
    expect(script).toContain("head -n 6");
  });

  it("path param vira último argumento do rg", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", path: "src" });
    const rg = rgArgsOf(execMock.mock.calls[0][1]);
    expect(rg[rg.length - 1]).toBe("src");
    expect(execMock.mock.calls[0][1].cwd).toBe("/work/proj");
  });

  it("cwd da busca é o cwd da criação do tool", async () => {
    execMock.mockResolvedValue(mockResult(""));
    const tool = createGrepTool("/outro/dir", DEFAULT_CONFIG);
    await tool.execute("id", { pattern: "x" }, undefined, () => {});
    expect(execMock.mock.calls[0][1].cwd).toBe("/outro/dir");
  });
});

describe("grep — exit codes e saída", () => {
  it("exit 0 com matches → texto", async () => {
    execMock.mockResolvedValue(mockResult("src/a.ts:1:foo\n"));
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toBe("src/a.ts:1:foo");
  });

  it("exit 1 (sem matches) → No matches found", async () => {
    execMock.mockResolvedValue(mockResult("", 1));
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toBe("No matches found");
  });

  it("exit 2 (erro) → mensagem de erro com stderr", async () => {
    execMock.mockResolvedValue({
      stdout: Buffer.from(""),
      stderr: "rg: permission denied",
      exitCode: 2,
      timedOut: false,
      aborted: false,
    });
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toContain("rg: permission denied");
  });

  it("exit code inesperado → erro genérico", async () => {
    execMock.mockResolvedValue(mockResult("", 3));
    const res = await run({ pattern: "foo" });
    expect(res.content[0].text).toContain("exit code 3");
  });

  it("limite atingido → aviso [N matches limit reached] e conteúdo truncado", async () => {
    const lines = Array.from({ length: 101 }, (_, i) => `f${i}.ts:1:x`);
    execMock.mockResolvedValue(mockResult(lines.join("\n")));
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).toContain("[100 matches limit reached]");
    expect(res.details?.matchLimitReached).toBe(100);
    const contentLines = res.content[0].text.split("\n").filter((l) => l.startsWith("f"));
    expect(contentLines).toHaveLength(100);
  });

  it("abaixo do limite → sem aviso", async () => {
    execMock.mockResolvedValue(mockResult("a.ts:1:x\nb.ts:1:x\n"));
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).not.toContain("matches limit reached");
  });
});
