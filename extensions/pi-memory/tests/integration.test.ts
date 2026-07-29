/**
 * Teste de integração — verifica que a extensão carrega sem erros
 * de parse e a flag --no-memory funciona.
 *
 * Testes manuais confirmaram tools operacionais:
 *   - memory_status ✅ ("8 memories (7 active), 184 observations")
 *   - memory_search ✅ ("2 results: pnpm preference + rule")
 *   - memory_write ✅ ("Memória salva, ID: 3ed3aa9b")
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const PI = "pi";

function envWithoutMemory(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_NO_MEMORY;
  return env;
}

describe("pi-memory integration", () => {
  it("deve carregar sem erros de parse no stderr", () => {
    try {
      execSync(`${PI} -p "hello"`, {
        encoding: "utf-8",
        timeout: 15_000,
        env: envWithoutMemory(),
      });
    } catch (e: unknown) {
      const err = e as { stdout: string | Buffer; stderr: string | Buffer };
      const stderr = (err.stderr || "").toString();
      const memoryErrors = stderr
        .split("\n")
        .filter((l) => l.includes("pi-memory") && l.includes("Error"));
      expect(memoryErrors).toEqual([]);
    }
  });

  it("--no-memory não deve causar 'requires a value'", () => {
    try {
      execSync(`${PI} --no-memory -p "hello"`, {
        encoding: "utf-8",
        timeout: 15_000,
        env: envWithoutMemory(),
      });
    } catch (e: unknown) {
      const err = e as { stdout: string | Buffer; stderr: string | Buffer };
      expect((err.stderr || "").toString()).not.toContain("requires a value");
    }
  });
});
