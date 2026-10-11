import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const VERIFY_CHECKS = ["test", "typecheck", "lint", "build"] as const;
type VerifyCheck = (typeof VERIFY_CHECKS)[number];

type DiscoveredCheck = { check: VerifyCheck; script: string; command: string; source: string };

type VerifyResult = {
  check: VerifyCheck;
  command: string;
  source: string;
  exitCode: number | null;
  output: string;
  ok: boolean;
};

type ExecuteCommand = (command: string, signal: AbortSignal, timeout: number) => Promise<{
  exitCode: number | null;
  output: string;
}>;

export async function discoverChecks(cwd: string, requested?: VerifyCheck[]): Promise<{
  packageManager: string;
  checks: DiscoveredCheck[];
}> {
  const selected = requested?.length ? requested : [...VERIFY_CHECKS];
  const fromContext = await discoverFromProjectContext(cwd, selected);
  const contextChecks = fromContext.checks ?? [];
  const missing = selected.filter((check) => !contextChecks.some((item) => item.check === check));
  const fromPackageJson: ProjectContextCommands = missing.length
    ? await discoverFromPackageJson(cwd, missing)
    : { packageManager: null, checks: [] };
  return {
    packageManager: fromContext.packageManager ?? fromPackageJson.packageManager ?? await detectPackageManager(cwd),
    checks: [...contextChecks, ...fromPackageJson.checks],
  };
}

interface ProjectContextCommands {
  packageManager: string | null;
  checks: DiscoveredCheck[];
}
/**
 * Comandos pré-computados pelo pi-project-context (com proveniência).
 * Só vale se o arquivo existir, for válido e não estiver velho: quando o
 * package.json é mais novo que o `detectedAt`, os scripts podem ter mudado
 * e a descoberta direta assume.
 */
async function discoverFromProjectContext(cwd: string, selected: VerifyCheck[]): Promise<Partial<ProjectContextCommands>> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, ".pi", "project-context.json"), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const context = parsed as Record<string, unknown>;
  if (!isFresh(context.detectedAt, await packageJsonMtime(cwd))) return {};

  const commands = context.commands;
  const checks: DiscoveredCheck[] = [];
  if (commands && typeof commands === "object" && !Array.isArray(commands)) {
    for (const check of selected) {
      const entry = (commands as Record<string, unknown>)[check];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { command, source } = entry as Record<string, unknown>;
      if (typeof command !== "string" || !command.trim()) continue;
      checks.push({
        check,
        script: check,
        command: command.trim(),
        source: typeof source === "string" && source ? source : ".pi/project-context.json",
      });
    }
  }
  const packageManager = typeof context.packageManager === "string" && context.packageManager.trim()
    ? context.packageManager.trim()
    : null;
  return { packageManager, checks };
}

async function packageJsonMtime(cwd: string): Promise<number | null> {
  try {
    return (await stat(join(cwd, "package.json"))).mtimeMs;
  } catch {
    return null;
  }
}

function isFresh(detectedAt: unknown, packageJsonMtime: number | null): boolean {
  if (typeof detectedAt !== "string") return false;
  const detected = Date.parse(detectedAt);
  if (!Number.isFinite(detected)) return false;
  // Sem package.json não há o que ter mudado; com, ele precisa ser anterior à detecção.
  return packageJsonMtime === null || packageJsonMtime <= detected;
}

async function discoverFromPackageJson(cwd: string, selected: VerifyCheck[]): Promise<ProjectContextCommands> {
  const raw = await readFile(join(cwd, "package.json"), "utf8");
  const packageJson = JSON.parse(raw) as { scripts?: Record<string, unknown> };
  const scripts = packageJson.scripts ?? {};
  const packageManager = await detectPackageManager(cwd);
  const checks = selected
    .filter((check) => typeof scripts[check] === "string")
    .map((check) => ({
      check,
      script: check,
      command: `${packageManager} run ${check}`,
      source: `package.json#scripts.${check}`,
    }));
  return { packageManager, checks };
}

async function detectPackageManager(cwd: string): Promise<string> {
  // Somente lockfiles: o .pi/project-context.json é consumido com checagem
  // de freshness em discoverFromProjectContext — reler aqui sem checar
  // ressuscitaria um contexto velho.
  for (const [file, command] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    try {
      await readFile(join(cwd, file));
      return command;
    } catch {
      // Continua procurando o lockfile mais específico disponível.
    }
  }
  return "npm";
}

export async function runVerification(
  cwd: string,
  requested: VerifyCheck[] | undefined,
  execute: ExecuteCommand,
  signal: AbortSignal,
  timeout: number,
): Promise<{ results: VerifyResult[]; skipped: VerifyCheck[]; packageManager: string }> {
  const { checks, packageManager } = await discoverChecks(cwd, requested);
  const selected = requested?.length ? requested : [...VERIFY_CHECKS];
  const available = new Set(checks.map(({ check }) => check));
  const skipped = selected.filter((check) => !available.has(check));
  const results: VerifyResult[] = [];

  for (const item of checks) {
    if (signal.aborted) throw new Error("verificação cancelada");
    try {
      const execution = await execute(item.command, signal, timeout);
      results.push({
        check: item.check,
        command: item.command,
        source: item.source,
        exitCode: execution.exitCode,
        output: execution.output.slice(-12_000),
        ok: execution.exitCode === 0,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      results.push({
        check: item.check,
        command: item.command,
        source: item.source,
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
        ok: false,
      });
    }
  }
  return { results, skipped, packageManager };
}

function formatResult(result: VerifyResult): string {
  const status = result.ok ? "✅" : "❌";
  return `${status} ${result.check} — ${result.command} (exit ${result.exitCode ?? "unknown"}, via ${result.source})${result.output ? `\n${result.output}` : ""}`;
}

export function createVerifyTool(
  getExecutor: (cwd: string) => ExecuteCommand,
  getWorkspaceCwd: () => string,
): Parameters<ExtensionAPI["registerTool"]>[0] {
  return {
    name: "verify",
    label: "Verify Project",
    description:
      "Executa verificações seguras do projeto (test, typecheck, lint e build) usando os scripts existentes no package.json. " +
      "Não aceita comandos arbitrários; retorna diagnóstico estruturado e continua após uma falha.",
    promptSnippet: "Executa testes, typecheck, lint e build disponíveis no projeto.",
    parameters: Type.Object({
      checks: Type.Optional(Type.Array(Type.Union(VERIFY_CHECKS.map((check) => Type.Literal(check))))),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 900 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const input = params as { checks?: VerifyCheck[]; timeoutSeconds?: number };
      const timeout = Math.round((input.timeoutSeconds ?? 300) * 1000);
      const requested = input.checks?.length ? [...new Set(input.checks)] : undefined;
      try {
        const cwd = getWorkspaceCwd();
        const report = await runVerification(
          cwd,
          requested,
          getExecutor(cwd),
          signal ?? new AbortController().signal,
          timeout,
        );
        const lines = [
          `## Verificação do projeto (${report.packageManager})`,
          ...report.results.map(formatResult),
          ...(report.skipped.length ? [`⏭️ indisponíveis: ${report.skipped.join(", ")}`] : []),
          report.results.length === 0 && report.skipped.length === 0
            ? "ℹ️ Nenhum script verificável foi encontrado no package.json."
            : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: lines.join("\n\n") }],
          details: { cwd, ...report },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `❌ Não foi possível verificar o projeto: ${message}` }],
          details: { cwd: getWorkspaceCwd(), error: message },
        };
      }
    },
  };
}
