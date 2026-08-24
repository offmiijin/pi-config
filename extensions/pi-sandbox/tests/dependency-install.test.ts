/** Testes do plano seguro de instalação npm. */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNpmInstallPlan } from "../dependency-install";

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
