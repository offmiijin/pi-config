import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type PhpTestScope = "all" | "file" | "test" | "suite";

export interface PhpUnitInput {
  scope?: PhpTestScope;
  path?: string;
  test?: string;
  suite?: string;
  timeoutSeconds?: number;
}

export interface PhpUnitPlan {
  version: string;
  image: string;
  executable: string;
  command: string[];
  socket: string;
  scope: PhpTestScope;
  detail: string;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const IMAGE = /^php:\d+\.\d+\.\d+-cli(?:@sha256:[a-f0-9]{64})?$/;

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function exactVersion(value: unknown): string | undefined {
  return typeof value === "string" && VERSION.test(value.trim()) ? value.trim() : undefined;
}

function versionsInProject(cwd: string): string[] {
  const versions: string[] = [];
  const composerPath = join(cwd, "composer.json");
  const composerText = readText(composerPath);
  if (composerText) {
    try {
      const composer = JSON.parse(composerText) as Record<string, any>;
      const platform = exactVersion(composer.config?.platform?.php);
      if (platform) versions.push(platform);
      const required = exactVersion(composer.require?.php);
      if (required) versions.push(required);
    } catch { /* diagnóstico abaixo informa ausência de versão exata. */ }
  }

  for (const file of [".php-version", ".tool-versions"]) {
    const text = readText(join(cwd, file));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const match = file === ".tool-versions"
        ? line.match(/^\s*php\s+(\d+\.\d+\.\d+)\s*$/)
        : line.match(/^\s*(\d+\.\d+\.\d+)\s*$/);
      const version = exactVersion(match?.[1]);
      if (version) versions.push(version);
    }
  }

  const mise = readText(join(cwd, "mise.toml"));
  const miseVersion = mise?.match(/^\s*php\s*=\s*["'](\d+\.\d+\.\d+)["']\s*$/m);
  const version = exactVersion(miseVersion?.[1]);
  if (version) versions.push(version);
  return [...new Set(versions)];
}

function projectPath(cwd: string, input: string): string {
  if (isAbsolute(input)) throw new Error("o caminho do teste deve ser relativo ao projeto");
  const absolute = resolve(cwd, input);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("o caminho do teste escapa do projeto");
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`arquivo de teste inexistente: ${input}`);
  return absolute;
}

function socketPath(): string {
  const configured = process.env.PI_SANDBOX_DOCKER_SOCKET?.trim();
  if (!configured) throw new Error("PI_SANDBOX_DOCKER_SOCKET não configurado");
  const socket = realpathSync(configured);
  if (!statSync(socket).isSocket()) throw new Error(`não é um socket Unix: ${configured}`);
  return socket;
}

export function detectPhpUnit(cwd: string): { executable: string; version: string } {
  const composer = readText(join(cwd, "composer.json"));
  if (!composer) throw new Error("PHPUnit não detectado: composer.json ausente");
  let parsed: Record<string, any>;
  try { parsed = JSON.parse(composer); } catch { throw new Error("PHPUnit não detectado: composer.json inválido"); }
  const dependency = parsed.require?.["phpunit/phpunit"] ?? parsed["require-dev"]?.["phpunit/phpunit"];
  if (typeof dependency !== "string") throw new Error("PHPUnit não detectado em composer.json");
  const executable = join(cwd, "vendor", "bin", "phpunit");
  if (!existsSync(executable)) throw new Error("PHPUnit declarado, mas vendor/bin/phpunit não existe");
  const versions = versionsInProject(cwd);
  if (versions.length !== 1) {
    throw new Error(versions.length > 1
      ? `versões PHP conflitantes: ${versions.join(", ")}`
      : "versão PHP exata não encontrada");
  }
  return { executable, version: versions[0] };
}

export function buildPhpUnitPlan(cwd: string, input: PhpUnitInput = {}): PhpUnitPlan {
  const { executable, version } = detectPhpUnit(cwd);
  const scope = input.scope ?? "all";
  const image = process.env.PI_SANDBOX_PHP_IMAGE?.trim() || `php:${version}-cli`;
  if (!IMAGE.test(image)) throw new Error(`imagem PHP não é exata ou não é permitida: ${image}`);

  const command = ["docker", "run", "--rm", "--init", "--network", "none", "--read-only", "--tmpfs", "/tmp",
    "--volume", `${cwd}:${cwd}:ro`, "--workdir", cwd, image, "phpunit"];
  let detail = "todos os testes";
  if (scope === "file") {
    if (!input.path) throw new Error("scope=file exige path");
    const file = projectPath(cwd, input.path);
    command.push(relative(cwd, file)); detail = `arquivo ${input.path}`;
  } else if (scope === "test") {
    if (!input.test?.trim()) throw new Error("scope=test exige test");
    command.push("--filter", input.test); detail = `teste ${input.test}`;
  } else if (scope === "suite") {
    if (!input.suite?.trim()) throw new Error("scope=suite exige suite");
    command.push("--testsuite", input.suite); detail = `suíte ${input.suite}`;
  }
  return { version, image, executable, command, socket: socketPath(), scope, detail };
}

export function dockerMountDirectory(socket: string): string {
  return dirname(socket);
}
