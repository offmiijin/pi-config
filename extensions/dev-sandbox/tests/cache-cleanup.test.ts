/** Testes da limpeza automática de caches persistentes. */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_RETENTION_MS, cleanupSandboxCaches } from "../cache-cleanup";

const fixtures: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-cleanup-"));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cleanupSandboxCaches", () => {
  it("remove arquivos antigos de npm/pip e preserva arquivos recentes", () => {
    const root = fixture();
    const npm = join(root, "npm");
    const pip = join(root, "pip");
    const clones = join(root, "clones");
    const quarantine = { fetch: join(root, "fetch"), runs: join(root, "runs") };
    const old = Date.now() - CACHE_RETENTION_MS - 1000;

    mkdirSync(join(npm, "content"), { recursive: true });
    mkdirSync(pip, { recursive: true });
    const oldNpm = join(npm, "content", "old");
    const freshPip = join(pip, "fresh");
    writeFileSync(oldNpm, "old");
    writeFileSync(freshPip, "fresh");
    utimesSync(oldNpm, old / 1000, old / 1000);

    const result = cleanupSandboxCaches({ npm, pip, clones }, quarantine, Date.now());

    expect(result.removed).toBe(1);
    expect(existsSync(oldNpm)).toBe(false);
    expect(existsSync(freshPip)).toBe(true);
  });

  it("remove clone, fetch e run inteiros apenas quando antigos", () => {
    const root = fixture();
    const cacheDirs = {
      npm: join(root, "npm"),
      pip: join(root, "pip"),
      clones: join(root, "clones"),
    };
    const quarantine = { fetch: join(root, "fetch"), runs: join(root, "runs") };
    const old = Date.now() - CACHE_RETENTION_MS - 1000;

    for (const [rootDir, name] of [
      [cacheDirs.clones, "old-clone"],
      [quarantine.fetch, "old-fetch"],
      [quarantine.runs, "old-run"],
    ]) {
      const entry = join(rootDir, name);
      mkdirSync(entry, { recursive: true });
      const file = join(entry, "payload");
      writeFileSync(file, "old");
      utimesSync(file, old / 1000, old / 1000);
      utimesSync(entry, old / 1000, old / 1000);
    }

    const freshRun = join(quarantine.runs, "fresh-run");
    mkdirSync(freshRun, { recursive: true });
    writeFileSync(join(freshRun, "venv-marker"), "keep");

    const result = cleanupSandboxCaches(cacheDirs, quarantine, Date.now());

    expect(result.removed).toBe(3);
    expect(existsSync(join(cacheDirs.clones, "old-clone"))).toBe(false);
    expect(existsSync(join(quarantine.fetch, "old-fetch"))).toBe(false);
    expect(existsSync(join(quarantine.runs, "old-run"))).toBe(false);
    expect(existsSync(freshRun)).toBe(true);
  });

  it("diretórios ausentes não falham", () => {
    const root = fixture();
    expect(() => cleanupSandboxCaches(
      { npm: join(root, "npm"), pip: join(root, "pip"), clones: join(root, "clones") },
      { fetch: join(root, "fetch"), runs: join(root, "runs") },
    )).not.toThrow();
  });
});
