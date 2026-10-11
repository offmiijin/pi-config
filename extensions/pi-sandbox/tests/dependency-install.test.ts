/** Testes do plano seguro de instalação npm. */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDependencyInstallPlan, createCargoInstallPlan, createGoInstallPlan, createNpmInstallPlan, createPipInstallPlan } from "../dependency-install";

const fixtures: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-install-"));
  fixtures.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createNpmInstallPlan", () => {
  it("usa npm ci com lockfile e ignora scripts", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(cwd, "package-lock.json"), "{}");

    expect(createNpmInstallPlan(cwd)).toEqual({
      command: ["npm", "ci", "--ignore-scripts"],
      lockfile: true,
    });
  });

  it("usa npm install sem lockfile", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "package.json"), "{}");

    expect(createNpmInstallPlan(cwd)).toEqual({
      command: ["npm", "install", "--ignore-scripts"],
      lockfile: false,
    });
  });

  it("exige package.json no worktree", () => {
    expect(() => createNpmInstallPlan(fixture())).toThrow(/package.json/);
  });
});

describe("createGoInstallPlan", () => {
  it("usa go mod download (só baixa, não executa)", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "go.mod"), "module example.com/app\n");
    expect(createGoInstallPlan(cwd)).toEqual({ command: ["go", "mod", "download"], lockfile: false });
  });

  it("detecta go.sum como lockfile", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "go.mod"), "module example.com/app\n");
    writeFileSync(join(cwd, "go.sum"), "");
    expect(createGoInstallPlan(cwd).lockfile).toBe(true);
  });

  it("exige go.mod no worktree", () => {
    expect(() => createGoInstallPlan(fixture())).toThrow(/go\.mod/);
  });
});

describe("createCargoInstallPlan", () => {
  it("usa cargo fetch com --locked quando há Cargo.lock", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "Cargo.toml"), '[package]\nname = "app"\n');
    writeFileSync(join(cwd, "Cargo.lock"), "");
    expect(createCargoInstallPlan(cwd)).toEqual({ command: ["cargo", "fetch", "--locked"], lockfile: true });
  });

  it("usa cargo fetch simples sem lockfile", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "Cargo.toml"), '[package]\nname = "app"\n');
    expect(createCargoInstallPlan(cwd)).toEqual({ command: ["cargo", "fetch"], lockfile: false });
  });

  it("exige Cargo.toml no worktree", () => {
    expect(() => createCargoInstallPlan(fixture())).toThrow(/Cargo\.toml/);
  });
});

describe("createPipInstallPlan", () => {
  it("prefere requirements.txt", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "requirements.txt"), "django==5.0\n");
    writeFileSync(join(cwd, "requirements-dev.txt"), "pytest\n");
    const plan = createPipInstallPlan(cwd);
    expect(plan.command.slice(0, 4)).toEqual(["python3", "-m", "pip", "install"]);
    expect(plan.command.join(" ")).toContain("requirements.txt");
  });

  it("aceita variantes requirements-*.txt", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "requirements-dev.txt"), "pytest\n");
    expect(createPipInstallPlan(cwd).command.join(" ")).toContain("requirements-dev.txt");
  });

  it("exige manifesto Python no worktree", () => {
    expect(() => createPipInstallPlan(fixture())).toThrow(/Python/);
  });
});

describe("createDependencyInstallPlan", () => {
  it("prioriza npm e identifica kind/manifest", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(cwd, "go.mod"), "module example.com/app\n");
    expect(createDependencyInstallPlan(cwd)).toMatchObject({ kind: "npm", manifest: "package.json" });
  });

  it("resolve go, cargo e pip", () => {
    const go = fixture();
    writeFileSync(join(go, "go.mod"), "module example.com/app\n");
    expect(createDependencyInstallPlan(go)).toMatchObject({ kind: "go", manifest: "go.mod" });

    const cargo = fixture();
    writeFileSync(join(cargo, "Cargo.toml"), '[package]\nname = "app"\n');
    expect(createDependencyInstallPlan(cargo)).toMatchObject({ kind: "cargo", manifest: "Cargo.toml" });

    const pip = fixture();
    writeFileSync(join(pip, "requirements.txt"), "django==5.0\n");
    expect(createDependencyInstallPlan(pip)).toMatchObject({ kind: "pip", manifest: "requirements.txt" });
  });

  it("lista manifestos suportados quando não há nenhum", () => {
    expect(() => createDependencyInstallPlan(fixture())).toThrow(/package\.json.*go\.mod.*Cargo\.toml/);
  });
});
