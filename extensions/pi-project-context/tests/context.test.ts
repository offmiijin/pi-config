import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectContext, formatProjectContext, saveProjectContext } from "../context.ts";

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

  it("rejeita package manager declarado desconhecido e usa o lockfile", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ packageManager: "comando-malicioso@1", scripts: { test: "vitest" } }));
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const context = await detectProjectContext(cwd);

    expect(context.packageManager).toBe("pnpm");
    expect(context.commands.test?.command).toBe("pnpm run test");
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
    const target = join(cwd, ".pi", "project-context.json");
    const saved = JSON.parse(await readFile(target, "utf8"));
    const entries = await readdir(join(cwd, ".pi"));
    const dirMode = (await stat(join(cwd, ".pi"))).mode & 0o777;
    const fileMode = (await stat(target)).mode & 0o777;

    expect(saved).toEqual(context);
    expect(entries).toEqual(["project-context.json"]);
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(summary).toContain("Contexto operacional");
    expect(summary).toContain(".pi/project-context.json");
  });
});
