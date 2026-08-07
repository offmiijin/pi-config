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
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execInSandbox } from "../bwrap-executor";
import type { SandboxConfig } from "../types";

let _config: SandboxConfig | null = null;

export function setGrepConfig(config: SandboxConfig): void {
  _config = config;
}

interface GrepToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
}

const DEFAULT_GREP_LIMIT = 100;

export function createGrepTool(cwd: string) {
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

      const config = _config;
      if (!config) {
        return {
          content: [{ type: "text", text: "Error: sandbox not initialized" }],
          details: undefined,
        };
      }

      const searchCwd = ctx?.cwd ?? cwd;

      // Constrói comando rg
      const rgArgs: string[] = [
        "--no-heading",
        "--with-filename",
        "--line-number",
        "--no-messages",
        "--color", "never",
      ];

      // Literal (--fixed-strings) vs regex
      if (params.literal) {
        rgArgs.push("--fixed-strings");
      }

      // Case insensitive
      if (params.ignoreCase) {
        rgArgs.push("--ignore-case");
      }

      // Context lines
      if (typeof params.context === "number" && params.context > 0) {
        rgArgs.push("-C", String(params.context));
      }

      // Glob filter
      if (typeof params.glob === "string" && params.glob) {
        rgArgs.push("--glob", params.glob);
      }

      // Limit via rg --max-count (applied per-file; head pipe not needed)
      const limit = typeof params.limit === "number" && params.limit > 0
        ? params.limit
        : DEFAULT_GREP_LIMIT;
      rgArgs.push("--max-count", String(limit));

      // Pattern
      rgArgs.push("--", pattern);

      // Path
      const searchPath = typeof params.path === "string" && params.path
        ? params.path
        : ".";
      rgArgs.push(searchPath);

      // Executa rg diretamente via bwrap (sem bash -c, sem pipe)
      const { stdout, stderr, exitCode } = await execInSandbox(config, {
        command: ["rg", ...rgArgs],
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

      const trimmed = stdout.toString().trim();

      if (!trimmed) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: undefined,
        };
      }

      const lines = trimmed.split("\n");
      const details: Record<string, unknown> = {};

      if (lines.length >= limit) {
        details.matchLimitReached = limit;
        const notice = `\n\n[${limit} matches limit reached]`;
        return {
          content: [{ type: "text", text: trimmed + notice }],
          details,
        };
      }

      return {
        content: [{ type: "text", text: trimmed }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}
