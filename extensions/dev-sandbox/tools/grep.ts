/**
 * Grep tool — busca de padrões em arquivos via bwrap + ripgrep.
 *
 * Substitui completamente o grep built-in, roteando a execução
 * do ripgrep (rg) para dentro do namespace bwrap.
 *
 * A tool built-in usa ripgrep com os seguintes parâmetros:
 *   rg --no-heading --with-filename --line-number
 *      [--max-count N] [--ignore-case] [-C N] [-g GLOB]
 *      <pattern> <path>
 *
 * Limite GLOBAL de matches: o pipeline `rg --json | head` é executado com
 * `set -o pipefail` e os argumentos do rg são passados via "$@" — sem
 * shell injection de pattern/path. O head corta só depois de garantir
 * `limit` matches completos (com contexto) e o NDJSON é parseado contando
 * eventos "match" — linhas de contexto NÃO contam para o limite.
 */

import { Type, type Static } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { execInSandbox } from "../bwrap-executor";
import type { SandboxConfig } from "../types";

interface GrepToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
}

const DEFAULT_GREP_LIMIT = 100;

interface RgJsonEventData {
  path?: { text?: string };
  line_number?: number;
  lines?: { text?: string };
}

interface RgJsonEvent {
  type?: string;
  data?: RgJsonEventData;
}

/** Reconstrói "path:line:conteúdo" a partir de um evento do rg --json. */
function formatRgEvent(data: RgJsonEventData | undefined): string {
  const path = data?.path?.text ?? "";
  const line = data?.line_number;
  let text = data?.lines?.text ?? "";
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return line !== undefined ? `${path}:${line}:${text}` : text;
}

/**
 * Parseia o NDJSON do `rg --json`, contando MATCHES (eventos "match") —
 * linhas de contexto NÃO contam para o limite. Trunca no `limit`-ésimo
 * match preservando o bloco de contexto que o segue.
 */
function parseRgJsonOutput(raw: string, limit: number): { lines: string[]; matchCount: number } {
  const display: Array<{ type: "match" | "context"; text: string }> = [];
  let matchCount = 0;

  for (const rawLine of raw.split("\n")) {
    if (!rawLine) continue;
    let ev: RgJsonEvent;
    try {
      ev = JSON.parse(rawLine) as RgJsonEvent;
    } catch {
      // NDJSON íntegro nunca falha — linha malformada é ignorada
      continue;
    }
    if (ev.type === "match") {
      matchCount++;
      display.push({ type: "match", text: formatRgEvent(ev.data) });
    } else if (ev.type === "context") {
      display.push({ type: "context", text: formatRgEvent(ev.data) });
    }
  }

  // Trunca após o `limit`-ésimo match, mantendo o contexto que o segue
  let cut = display.length;
  let seen = 0;
  for (let i = 0; i < display.length; i++) {
    if (display[i].type === "match") {
      seen++;
      if (seen === limit) {
        cut = i + 1;
        while (cut < display.length && display[cut].type === "context") cut++;
        break;
      }
    }
  }

  return { lines: display.slice(0, cut).map((d) => d.text), matchCount };
}

const GrepParamsSchema = Type.Object({
  pattern: Type.String({ description: "Pattern to search for (regex by default)" }),
  path: Type.Optional(
    Type.String({
      description: "File or directory to search in (default: current directory)",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description: "Glob pattern to filter files (e.g. '*.ts', 'src/**')",
    }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: "Treat pattern as literal string, not regex",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({
      description: "Case-insensitive search",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Number of context lines to show around each match",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum matches to return (default: ${DEFAULT_GREP_LIMIT})`,
    }),
  ),
});

type GrepParams = Static<typeof GrepParamsSchema>;

export function createGrepTool(cwd: string, config: SandboxConfig, workspaceRoot = cwd) {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search for a pattern in files. Uses ripgrep. " +
      "Returns file:line:content for each match.",
    parameters: GrepParamsSchema,
    async execute(
      _toolCallId: string,
      params: GrepParams,
      signal: AbortSignal | undefined,
      _onUpdate?: (partialResult: AgentToolResult<any>) => void,
    ): Promise<GrepToolResult> {
      const pattern = params.pattern;
      if (!pattern) {
        return {
          content: [{ type: "text", text: "Error: pattern is required" }],
          details: undefined,
        };
      }

      const searchCwd = cwd;

      // Constrói comando rg (args passados via "$@" — sem shell injection)
      const rgArgs: string[] = ["--json", "--no-messages"];

      if (params.literal) {
        rgArgs.push("--fixed-strings");
      }

      if (params.ignoreCase) {
        rgArgs.push("--ignore-case");
      }

      const context =
        typeof params.context === "number" &&
        Number.isFinite(params.context) &&
        params.context > 0
          ? Math.floor(params.context)
          : 0;
      if (context > 0) {
        rgArgs.push("-C", String(context));
      }

      if (typeof params.glob === "string" && params.glob) {
        rgArgs.push("--glob", params.glob);
      }

      // Limite GLOBAL de matches — sem --max-count por arquivo. O head
      // corta o rg só depois de garantir `limit` matches COMPLETOS (com
      // seus blocos de contexto) e o NDJSON é contado por eventos "match".
      const limit =
        typeof params.limit === "number" &&
        Number.isFinite(params.limit) &&
        params.limit > 0
          ? Math.floor(params.limit)
          : DEFAULT_GREP_LIMIT;

      rgArgs.push("--", pattern);

      const searchPath = typeof params.path === "string" && params.path
        ? params.path
        : ".";
      rgArgs.push(searchPath);

      // Cada match gera até (2*context + 1) eventos (match + contexto),
      // mais begin/end por arquivo. Cap para `limit + 1` matches garante
      // que o head nunca corte no meio de um bloco e que o match excedente
      // apareça no stdout quando existir (matchCount > limit → aviso).
      const eventsPerMatch = 2 * context + 3;
      const cap = (limit + 1) * eventsPerMatch + 4;
      const script = `set -o pipefail; rg "$@" | head -n ${cap}`;
      const { stdout, stderr, exitCode } = await execInSandbox(config, {
        command: ["bash", "-c", script, "_", ...rgArgs],
        cwd: searchCwd,
        ...(workspaceRoot !== searchCwd ? { workspaceRoot } : {}),
        signal,
      });

      const { lines, matchCount } = parseRgJsonOutput(stdout.toString(), limit);
      const limitReached = matchCount > limit;

      // rg exit code: 0 = matches, 1 = sem matches (ou pipe cortado pelo
      // head quando o limite é atingido), 2 = erro. Qualquer outro valor
      // com limite não atingido também é erro.
      if (exitCode === 2 || (exitCode !== 0 && exitCode !== 1 && !limitReached)) {
        const errText = stderr.trim() || `grep failed (exit code ${exitCode})`;
        return {
          content: [{ type: "text", text: `Error: ${errText}` }],
          details: undefined,
        };
      }

      const text = lines.join("\n");

      if (!text.trim()) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: undefined,
        };
      }

      if (limitReached) {
        return {
          content: [{ type: "text", text: text + `\n\n[${limit} matches limit reached]` }],
          details: { matchLimitReached: limit },
        };
      }

      return {
        content: [{ type: "text", text }],
        details: undefined,
      };
    },
  };
}
