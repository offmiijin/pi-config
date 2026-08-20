/**
 * Testes do tool grep (ripgrep via sandbox).
 *
 * Cobre: construção do comando bash (pipefail + head com cap que preserva
 * contexto), passagem dos args do rg via "$@" (sem shell injection), parse
 * do NDJSON do rg --json (matches contam pro limite, contexto não), exit
 * codes (0/1/2) e aviso de limite atingido.
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

/** Evento NDJSON do rg --json. */
function jsonEvent(type: string, path: string, line: number | undefined, text: string): string {
  const data: Record<string, unknown> = { path: { text: path }, lines: { text: text + "\n" } };
  if (line !== undefined) data.line_number = line;
  return JSON.stringify({ type, data });
}
function matchEvent(path: string, line: number, text: string): string {
  return jsonEvent("match", path, line, text);
}
function contextEvent(path: string, line: number, text: string): string {
  return jsonEvent("context", path, line, text);
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
  it("bash com pipefail e head com cap; rg com --json", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "foo" });
    const [, call] = execMock.mock.calls[0];
    const cmd = call.command as string[];
    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    const script = cmd[2] as string;
    expect(script).toContain("set -o pipefail");
    expect(script).toContain('rg "$@"');
    // limit default 100, sem contexto: cap = (100+1)*(2*0+3)+4 = 307
    expect(script).toContain("head -n 307");

    const rg = rgArgsOf(call);
    expect(rg).toContain("--json");
    expect(rg).toContain("--no-messages");
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

  it("context → -C N e head com cap que preserva contexto", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", context: 3 });
    const rg = rgArgsOf(execMock.mock.calls[0][1]);
    expect(rg).toContain("-C");
    expect(rg[rg.indexOf("-C") + 1]).toBe("3");
    // cap = (100+1)*(2*3+3)+4 = 913
    const script = (execMock.mock.calls[0][1].command as string[])[2] as string;
    expect(script).toContain("head -n 913");
  });

  it("glob → --glob", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", glob: "*.ts" });
    const rg = rgArgsOf(execMock.mock.calls[0][1]);
    expect(rg).toContain("--glob");
    expect(rg[rg.indexOf("--glob") + 1]).toBe("*.ts");
  });

  it("limit custom → head com cap proporcional", async () => {
    execMock.mockResolvedValue(mockResult(""));
    await run({ pattern: "x", limit: 5 });
    // cap = (5+1)*(2*0+3)+4 = 22
    const script = (execMock.mock.calls[0][1].command as string[])[2] as string;
    expect(script).toContain("head -n 22");
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
  it("exit 0 com matches → texto file:line:content", async () => {
    execMock.mockResolvedValue(mockResult(matchEvent("src/a.ts", 1, "foo")));
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

  it("limite atingido → trunca em N matches e avisa", async () => {
    const events = Array.from({ length: 101 }, (_, i) => matchEvent(`f${i}.ts`, 1, "x"));
    execMock.mockResolvedValue(mockResult(events.join("\n")));
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).toContain("[100 matches limit reached]");
    expect(res.details?.matchLimitReached).toBe(100);
    const contentLines = res.content[0].text.split("\n").filter((l) => l.startsWith("f"));
    expect(contentLines).toHaveLength(100);
  });

  it("exit 1 com pipe cortado e matches acima do limite → aviso, não erro", async () => {
    // rg encerra com exit 1 quando o head corta o pipe após o cap
    const events = Array.from({ length: 150 }, (_, i) => matchEvent(`f${i}.ts`, 1, "x"));
    execMock.mockResolvedValue(mockResult(events.join("\n"), 1));
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).not.toContain("Error");
    expect(res.content[0].text).toContain("[100 matches limit reached]");
  });

  it("remove contexto duplicado entre matches sobrepostos", async () => {
    const events = [
      matchEvent("a.ts", 1, "x1"),
      contextEvent("a.ts", 2, "shared"),
      matchEvent("a.ts", 3, "x2"),
      contextEvent("a.ts", 2, "shared"),
    ];
    execMock.mockResolvedValue(mockResult(events.join("\n")));
    const res = await run({ pattern: "x", context: 1 });
    expect(res.content[0].text.match(/a.ts:2:shared/g)).toHaveLength(1);
  });

  it("limita a saída por bytes sem descartar o match inteiro", async () => {
    const longLine = "x".repeat(60 * 1024);
    execMock.mockResolvedValue(mockResult(matchEvent("a.ts", 1, longLine)));
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).toContain("[grep output limited to 51200 bytes]");
    expect(res.details).toMatchObject({ outputTruncated: true, outputMaxBytes: 51200 });
  });

  it("contexto NÃO conta pro limite; bloco completo preservado", async () => {
    const events = [
      contextEvent("a.ts", 0, "pre"),
      matchEvent("a.ts", 1, "x1"),
      contextEvent("a.ts", 2, "pos1"),
      matchEvent("a.ts", 3, "x2"),
      contextEvent("a.ts", 4, "pos2"),
      matchEvent("a.ts", 5, "x3"),
      contextEvent("a.ts", 6, "pos3"),
    ];
    execMock.mockResolvedValue(mockResult(events.join("\n")));
    const res = await run({ pattern: "x", context: 1, limit: 2 });
    const text = res.content[0].text;
    expect(text).toContain("a.ts:1:x1");
    expect(text).toContain("a.ts:2:pos1");
    expect(text).toContain("a.ts:3:x2");
    expect(text).toContain("a.ts:4:pos2"); // contexto do 2º match preservado
    expect(text).toContain("[2 matches limit reached]");
    expect(text).not.toContain("x3"); // 3º match truncado
    expect(res.details?.matchLimitReached).toBe(2);
  });

  it("abaixo do limite → sem aviso", async () => {
    execMock.mockResolvedValue(mockResult(
      matchEvent("a.ts", 1, "x") + "\n" + matchEvent("b.ts", 1, "x"),
    ));
    const res = await run({ pattern: "x" });
    expect(res.content[0].text).not.toContain("matches limit reached");
    expect(res.content[0].text).toContain("a.ts:1:x");
  });
});
