import { describe, expect, it } from "vitest";
import {
  compactBashOutput,
  compactBashToolError,
  compactBashToolResult,
} from "../tools/bash-output";

describe("compactação de saída do bash", () => {
  it("minifica JSON válido", () => {
    const result = compactBashOutput("gh issue list --json number,title", '{\n  "items": [1, 2]\n}');
    expect(result.changed).toBe(true);
    expect(result.kind).toBe("json");
    expect(result.output).toBe('{"items":[1,2]}');
  });

  it("reconhece scripts de teste com sufixo do workspace", () => {
    const output = Array.from({ length: 40 }, (_, index) => `PASS test-${index}`).join("\n");
    const result = compactBashOutput("npm run test:pi-sandbox", output);
    expect(result.kind).toBe("test");
    expect(result.changed).toBe(true);
  });

  it("filtra linhas repetitivas de testes e preserva falhas", () => {
    const output = Array.from({ length: 40 }, (_, index) =>
      index === 30 ? "FAIL src/auth.test.ts:42 invalid token" : `PASS test-${index}`,
    ).join("\n");
    const result = compactBashOutput("npm test", output);
    expect(result.changed).toBe(true);
    expect(result.kind).toBe("test");
    expect(result.output).toContain("FAIL src/auth.test.ts:42 invalid token");
    expect(result.output).toContain("linhas de saída omitidas");
  });

  it("filtra ruído de logs e preserva erro", () => {
    const output = Array.from({ length: 40 }, (_, index) =>
      index === 20 ? "2026-01-01 ERROR database unavailable" : `2026-01-01 INFO polling ${index}`,
    ).join("\n");
    const result = compactBashOutput("docker logs api", output);
    expect(result.changed).toBe(true);
    expect(result.kind).toBe("log");
    expect(result.output).toContain("ERROR database unavailable");
  });

  it("não altera saída de comando desconhecido", () => {
    const output = Array.from({ length: 40 }, (_, index) => `linha ${index}`).join("\n");
    const result = compactBashOutput("cat arquivo.txt", output);
    expect(result.changed).toBe(false);
    expect(result.output).toBe(output);
  });

  it("transforma apenas blocos textuais do resultado", () => {
    const output = Array.from({ length: 40 }, (_, index) => `PASS test-${index}`).join("\n");
    const result = compactBashToolResult({
      content: [
        { type: "text", text: output },
        { type: "image", data: "preservar" },
      ],
      details: { exitCode: 0 },
    }, { command: "npm test" }) as { content: Array<Record<string, unknown>>; details: Record<string, unknown> };
    expect(result.content[0]?.text).toContain("linhas de saída omitidas");
    expect(result.content[1]).toEqual({ type: "image", data: "preservar" });
    expect(result.details.piSandboxCompaction).toBeDefined();
  });

  it("compacta mensagens de erro do bash sem mascarar comando desconhecido", () => {
    const error = compactBashToolError(
      new Error(["PASS test-1", "FAIL src/a.test.ts:2", ...Array.from({ length: 30 }, (_, i) => `PASS ${i}`)].join("\n")),
      { command: "npm test" },
    );
    expect(error.message).toContain("FAIL src/a.test.ts:2");
    expect(error.message).toContain("linhas de saída omitidas");
  });
});
