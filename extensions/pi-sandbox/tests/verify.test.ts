import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverChecks, runVerification } from "../tools/verify";

describe("verify", () => {
  it("descobre apenas scripts verificáveis e o package manager", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: {
      test: "vitest", typecheck: "tsc", deploy: "ship-it",
    } }));
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");
    await expect(discoverChecks(cwd)).resolves.toMatchObject({
      packageManager: "pnpm",
      checks: [
        { check: "test", command: "pnpm run test" },
        { check: "typecheck", command: "pnpm run typecheck" },
      ],
    });
  });

  it("continua após erro de execução de um check", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "npm test", lint: "eslint ." } }));
    const report = await runVerification(cwd, undefined, async (command) => {
      if (command.includes("test")) throw new Error("timeout:300");
      return { exitCode: 0, output: "ok" };
    }, new AbortController().signal, 1000);
    expect(report.results.map((result) => result.ok)).toEqual([false, true]);
  });

  it("executa checks selecionados, continua após falha e limita a saída", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: {
      test: "npm test", lint: "eslint .",
    } }));
    const calls: string[] = [];
    const report = await runVerification(cwd, ["test", "typecheck", "lint"], async (command) => {
      calls.push(command);
      return { exitCode: command.includes("test") ? 1 : 0, output: "x".repeat(20_000) };
    }, new AbortController().signal, 1000);
    expect(calls).toEqual(["npm run test", "npm run lint"]);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.output).toHaveLength(12_000);
    expect(report.skipped).toEqual(["typecheck"]);
  });
});
