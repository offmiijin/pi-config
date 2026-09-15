import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectContext, formatProjectContext, saveProjectContext } from "./context.ts";

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-"));
  await mkdir(join(cwd, ".pi"));
  return cwd;
}

describe("contexto do projeto", () => {
  it("detecta stack, framework, package manager e scripts", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      packageManager: "pnpm@9.0.0",
      scripts: { test: "vitest", lint: "eslint .", build: "tsc" },
      dependencies: { react: "^19" },
      devDependencies: { typescript: "^5", vitest: "^4" },
    }));
    const context = await detectProjectContext(cwd, new Date("2026-01-02T03:04:05.000Z"));
    expect(context.stack).toEqual(["Node.js", "React", "TypeScript", "Vitest"]);
    expect(context.packageManager).toBe("pnpm");
    expect(context.commands.test?.command).toBe("pnpm run test");
    expect(context.commands.typecheck).toBeUndefined();
  });

  it("usa lockfile e não inventa comandos ausentes", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "npm test" } }));
    await writeFile(join(cwd, "package-lock.json"), "{}");
    const context = await detectProjectContext(cwd);
    expect(context.packageManager).toBe("npm");
    expect(context.commands).toEqual({});
  });

  it("persiste atomicamente e formata resumo curto", async () => {
    const cwd = await fixture();
    const context = await detectProjectContext(cwd);
    await saveProjectContext(cwd, context);
    const summary = formatProjectContext(context);
    expect(summary).toContain("Contexto operacional");
    expect(summary).toContain(".pi/project-context.json");
  });
});
