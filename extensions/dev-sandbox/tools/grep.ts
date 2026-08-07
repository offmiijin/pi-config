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
 * Limite global de matches: o pipeline `rg | head` é executado com
 * `set -o pipefail` (preserva o exit code do rg) e os argumentos do
 * rg são passados via "$@" — sem shell injection de pattern/path.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execInSandbox } from "../bwrap-executor";
import type { SandboxConfig } from "../types";

interface GrepToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
}

const DEFAULT_GREP_LIMIT = 100;

export function createGrepTool(cwd: string, config: SandboxConfig) {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search for a pattern in files. Uses ripgrep. " +
      "Returns file:line:content for each match.",
    parameters: Type.Object({
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
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: (data: Buffer) => void,
      ctx: ExtensionContext,
    ): Promise<GrepToolResult> {
      const pattern = String(params.pattern || "");
      if (!pattern) {
        return {
          content: [{ type: "text", text: "Error: pattern is required" }],
          details: undefined,
        };
      }

      const searchCwd = ctx?.cwd ?? cwd;

      // Constrói comando rg (args passados via "$@" — sem shell injection)
      const rgArgs: string[] = [
        "--no-heading",
        "--with-filename",
        "--line-number",
        "--no-messages",
        "--color", "never",
      ];

      if (params.literal) {
        rgArgs.push("--fixed-strings");
      }

      if (params.ignoreCase) {
        rgArgs.push("--ignore-case");
      }

      if (typeof params.context === "number" && params.context > 0) {
        rgArgs.push("-C", String(params.context));
      }

      if (typeof params.glob === "string" && params.glob) {
        rgArgs.push("--glob", params.glob);
      }

      // Limite global (head) — sem --max-count por arquivo
      const limit = typeof params.limit === "number" && params.limit > 0
        ? params.limit
        : DEFAULT_GREP_LIMIT;

      rgArgs.push("--", pattern);

      const searchPath = typeof params.path === "string" && params.path
        ? params.path
        : ".";
      rgArgs.push(searchPath);

      // pipefail preserva o exit code do rg; head aplica o limite global
      const script = `set -o pipefail; rg "$@" | head -n ${limit + 1}`;
      const { stdout, stderr, exitCode } = await execInSandbox(config, {
        command: ["bash", "-c", script, "_", ...rgArgs],
        cwd: searchCwd,
        signal,
      });

      // rg exit code: 0 = matches found, 1 = no matches, 2 = error
      if (exitCode === 2 || (exitCode !== 0 && exitCode !== 1)) {
        const errText = stderr.trim() || `grep failed (exit code ${exitCode})`;
        return {
          content: [{ type: "text", text: `Error: ${errText}` }],
          details: undefined,
        };
      }

      let lines = stdout.toString().split("\n");
      // Remove trailing vazio (stdout termina com \n)
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      let details: Record<string, unknown> | undefined;
      let text: string;

      if (lines.length > limit) {
        lines = lines.slice(0, limit);
        details = { matchLimitReached: limit };
        text = lines.join("\n") + `\n\n[${limit} matches limit reached]`;
      } else {
        text = lines.join("\n");
      }

      if (!text.trim()) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  };
}
