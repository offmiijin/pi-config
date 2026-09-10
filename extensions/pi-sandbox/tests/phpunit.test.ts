import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPhpUnitPlan, detectPhpUnit } from "../tools/phpunit";

const dirs: string[] = [];
const oldSocket = process.env.PI_SANDBOX_DOCKER_SOCKET;
const oldImage = process.env.PI_SANDBOX_PHP_IMAGE;

function project(composer: string, versionFile = ".php-version"): string {
  const cwd = mkdtempSync(join(tmpdir(), "phpunit-plan-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "composer.json"), composer);
  writeFileSync(join(cwd, versionFile), "8.3.12\n");
  mkdirSync(join(cwd, "vendor", "bin"), { recursive: true });
  writeFileSync(join(cwd, "vendor", "bin", "phpunit"), "#!/bin/sh\n");
  writeFileSync(join(cwd, "tests.php"), "<?php\n");
  return cwd;
}

async function socketAt(path: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return server;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (oldSocket === undefined) delete process.env.PI_SANDBOX_DOCKER_SOCKET;
  else process.env.PI_SANDBOX_DOCKER_SOCKET = oldSocket;
  if (oldImage === undefined) delete process.env.PI_SANDBOX_PHP_IMAGE;
  else process.env.PI_SANDBOX_PHP_IMAGE = oldImage;
});

describe("adapter PHPUnit", () => {
  it("detecta PHPUnit e exige versão PHP exata", () => {
    const cwd = project(JSON.stringify({ "require-dev": { "phpunit/phpunit": "^11" } }));
    expect(detectPhpUnit(cwd).version).toBe("8.3.12");
  });

  it("recusa projeto sem versão PHP exata", () => {
    const cwd = project(JSON.stringify({ "require-dev": { "phpunit/phpunit": "^11" } }));
    rmSync(join(cwd, ".php-version"));
    expect(() => detectPhpUnit(cwd)).toThrow("versão PHP exata");
  });

  it("gera operação para arquivo e monta apenas imagem exata", async () => {
    const cwd = project(JSON.stringify({ "config": { "platform": { "php": "8.3.12" } }, "require-dev": { "phpunit/phpunit": "^11" } }));
    rmSync(join(cwd, ".php-version"));
    const socket = join(cwd, "docker.sock");
    const server = await socketAt(socket);
    try {
      process.env.PI_SANDBOX_DOCKER_SOCKET = socket;
      const plan = buildPhpUnitPlan(cwd, { scope: "file", path: "tests.php" });
      expect(plan.image).toBe("php:8.3.12-cli");
      expect(plan.command).toContain("--rm");
      expect(plan.command).toContain("tests.php");
      expect(plan.command).toContain(join(cwd, "vendor", "bin", "phpunit"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("recusa imagem PHP sem versão exata", async () => {
    const cwd = project(JSON.stringify({ "require-dev": { "phpunit/phpunit": "^11" } }));
    const socket = join(cwd, "docker.sock");
    const server = await socketAt(socket);
    try {
      process.env.PI_SANDBOX_DOCKER_SOCKET = socket;
      process.env.PI_SANDBOX_PHP_IMAGE = "php:8.3-cli";
      expect(() => buildPhpUnitPlan(cwd)).toThrow("imagem PHP não é exata");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
