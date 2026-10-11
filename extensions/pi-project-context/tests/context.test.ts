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

  it("detecta Deno, C#, Swift, Dart e C/C++ por marcadores", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "deno.json"), "{}");
    await writeFile(join(cwd, "app.csproj"), "<Project/>");
    await writeFile(join(cwd, "Package.swift"), "// swift-tools-version: 5.9");
    await writeFile(join(cwd, "pubspec.yaml"), "name: app\n");
    await writeFile(join(cwd, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.28)\n");
    const context = await detectProjectContext(cwd);
    expect(context.stack).toEqual(["C#", "C/C++", "Dart/Flutter", "Deno", "Swift"]);
    expect(context.packageManager).toBeNull();
  });

  it("detecta frameworks Python via requirements e pyproject", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "requirements-dev.txt"), "django==5.0\npytest>=8\nrequests\n");
    await writeFile(join(cwd, "pyproject.toml"), '[project]\ndependencies = ["fastapi>=0.110"]\n');
    await writeFile(join(cwd, ".python-version"), "3.12.1\n");
    const context = await detectProjectContext(cwd);
    expect(context.stack).toEqual(["Django", "FastAPI", "Pytest", "Python 3.12"]);
  });

  it("detecta frameworks Rust, Go, PHP, Ruby e Elixir pelo conteúdo", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "Cargo.toml"), '[package]\nname = "app"\n[dependencies]\ntokio = "1"\nserde = "1"\n');
    await writeFile(join(cwd, "go.mod"), "module example.com/app\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9\n");
    await writeFile(join(cwd, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11" } }));
    await writeFile(join(cwd, "Gemfile"), 'source "https://rubygems.org"\ngem "rails", "~> 7"\n');
    await writeFile(join(cwd, "mix.exs"), 'defmodule App.MixProject do\n  {:phoenix, "~> 1.7"}\nend\n');
    const context = await detectProjectContext(cwd);
    expect(context.stack).toEqual([
      "Elixir", "Gin", "Go 1.22", "Laravel", "PHP", "Phoenix", "Rails", "Ruby", "Rust", "Serde", "Tokio",
    ]);
  });

  it("versiona Node.js via engines sem quebrar o rótulo base", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ engines: { node: ">=20" } }));
    const context = await detectProjectContext(cwd);
    expect(context.stack).toEqual(["Node.js 20"]);
    expect(context.packageManager).toBe("npm");
  });

  it("ignora manifests corrompidos sem lançar", async () => {
    const cwd = await fixture();
    await writeFile(join(cwd, "Cargo.toml"), "[dependencies\nTHIS IS NOT VALID");
    await writeFile(join(cwd, "composer.json"), "{invalid");
    await writeFile(join(cwd, "requirements.txt"), "django==5.0\n");
    const context = await detectProjectContext(cwd);
    // Marcador por arquivo vale mesmo com conteúdo inválido; framework exige parse.
    expect(context.stack).toEqual(["Django", "PHP", "Python", "Rust"]);
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
