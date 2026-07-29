/**
 * Testes do GitLayer — versionamento git do wiki.
 *
 * NOTA: Requer git instalado no sistema.
 * Se git não estiver disponível, os testes pulam gracefulmente.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { GitLayer } from "../../wiki/git-layer";

// ── Setup ──────────────────────────────────────────────────────────────

let gitAvailable = false;
try {
  execSync("git --version", { encoding: "utf-8", timeout: 5_000 });
  gitAvailable = true;
} catch {
  // git não disponível
}

function createSandboxDir(): string {
  const dir = path.join(tmpdir(), "pi-git-test-" + randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, filePath: string, content: string): string {
  const fullPath = path.join(dir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

// ── Suíte ──────────────────────────────────────────────────────────────

(gitAvailable ? describe : describe.skip)("GitLayer", () => {
  it("deve inicializar repositório git", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, {
      enabled: true,
      commitPerPage: true,
      authorName: "test",
      authorEmail: "test@test",
    });

    git.init();

    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
  });

  it("deve commitar página imediatamente (commitPerPage=true)", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, {
      enabled: true,
      commitPerPage: true,
      authorName: "test",
      authorEmail: "test@test",
    });

    git.init();
    writeFile(dir, "decisions/test.md", "# Test page");
    git.stage("decisions/test.md");

    const log = git.log();
    expect(log.length).toBeGreaterThanOrEqual(2); // init + file commit
  });

  it("deve commitar em batch (commitPerPage=false)", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, {
      enabled: true,
      commitPerPage: false,
      batchIntervalMs: 100,
      authorName: "test",
      authorEmail: "test@test",
    });

    git.init();
    writeFile(dir, "decisions/a.md", "# A");
    writeFile(dir, "decisions/b.md", "# B");

    git.stage("decisions/a.md");
    git.stage("decisions/b.md");
    git.flush();

    const log = git.log();
    expect(log.length).toBeGreaterThanOrEqual(2); // init + batch
  });

  it("deve retornar log vazio se git desabilitado", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, { enabled: false });
    git.init();

    const log = git.log();
    expect(log).toEqual([]);
  });

  it("deve restaurar versão anterior", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, {
      enabled: true,
      commitPerPage: true,
      authorName: "test",
      authorEmail: "test@test",
    });

    git.init();

    const filePath = "decisions/test.md";
    writeFile(dir, filePath, "# Version 1");
    git.stage(filePath);

    writeFile(dir, filePath, "# Version 2");
    git.stage(filePath);

    git.restore(filePath, "HEAD~1");
    const content = fs.readFileSync(path.join(dir, filePath), "utf-8");
    expect(content).toContain("Version 1");
  });

  it("enabled=false não deve criar .git", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, { enabled: false });
    git.init();

    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  });

  it("status deve reportar branch", () => {
    const dir = createSandboxDir();
    const git = new GitLayer(dir, {
      enabled: true,
      commitPerPage: true,
      authorName: "test",
      authorEmail: "test@test",
    });

    git.init();
    const status = git.status;
    expect(status.available).toBe(true);
    expect(status.branch).toBeTruthy();
  });
});
