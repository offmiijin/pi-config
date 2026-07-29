/**
 * Tool: memory_restore_page
 *
 * Restaura versão anterior de uma página via .superseded/ ou git.
 * Permite preview do diff antes de restaurar.
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PageStore } from "../storage/page-store";
import type { GitLayer } from "../wiki/git-layer";

export interface RestoreDeps {
  pageStore: PageStore;
  wikiRoot: string;
  gitLayer?: GitLayer;
  projectId: string;
}

// ── Version info ───────────────────────────────────────────────────────

export interface SupersededVersion {
  date: string;        // ISO date ou timestamp no filename
  fullPath: string;    // path absoluto no .superseded/
  label: string;       // label amigável
}

// ── Tool factory ───────────────────────────────────────────────────────

export function createMemoryRestoreTool(deps: RestoreDeps) {
  return {
    name: "memory_restore_page",
    label: "Memory: Restore Page",
    description:
      "Restore a previous version of a wiki page. " +
      "Use preview=true to see the diff before restoring. " +
      "Versions come from .superseded/ directory or git history (if enabled).",

    parameters: Type.Object({
      path: Type.String({
        description: "Page path to restore (ex: 'decisions/hexagonal-arch.md')",
      }),
      source: Type.Optional(
        Type.Union(
          [Type.Literal("superseded"), Type.Literal("git")],
          { description: "Version source: 'superseded' (default) or 'git'", default: "superseded" }
        )
      ),
      version: Type.Optional(
        Type.Number({ description: "Which version (1 = most recent)", default: 1 })
      ),
      date: Type.Optional(
        Type.String({ description: "Restore to a specific date (ISO format, e.g. '2026-07-28')" })
      ),
      preview: Type.Optional(
        Type.Boolean({ description: "Show diff without restoring", default: false })
      ),
      scope: Type.Optional(
        Type.Union(
          [Type.Literal("project"), Type.Literal("global")],
          { description: "Scope of the page", default: "project" }
        )
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        path: string;
        source?: string;
        version?: number;
        date?: string;
        preview?: boolean;
        scope?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const scope = (params.scope as "project" | "global") ?? "project";
      const projectId = scope === "global" ? "_global" : deps.projectId;
      const source = params.source ?? "superseded";
      const pagePath = params.path.replace(/\.md$/, "") + ".md";

      // Verifica se página atual existe
      const currentPage = deps.pageStore.readPage(projectId, pagePath);
      const currentBody = currentPage?.body ?? "";

      if (source === "superseded") {
        return handleSupersededRestore(deps, pagePath, projectId, scope, params, currentBody);
      } else if (source === "git") {
        return handleGitRestore(deps, pagePath, projectId, params, currentBody);
      }

      return {
        content: [{ type: "text" as const, text: `Invalid source '${source}'. Use 'superseded' or 'git'.` }],
        details: { error: "invalid source" },
      };
    },
  };
}

// ── Handlers ───────────────────────────────────────────────────────────

async function handleSupersededRestore(
  deps: RestoreDeps,
  pagePath: string,
  projectId: string,
  scope: "project" | "global",
  params: { version?: number; date?: string; preview?: boolean },
  currentBody: string,
) {
  const versions = listSupersededVersions(deps, projectId, pagePath, scope);

  if (versions.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No superseded versions found for ${pagePath}.` }],
      details: { versions: [] },
    };
  }

  // Seleciona versão: por date ou por número
  let selectedVersion: SupersededVersion | null = null;

  if (params.date) {
    selectedVersion = versions.find((v) => v.date.startsWith(params.date!)) ?? null;
  } else {
    const idx = (params.version ?? 1) - 1;
    selectedVersion = versions[idx] ?? null;
  }

  if (!selectedVersion) {
    return {
      content: [{ type: "text" as const, text: `Version not found. Available versions: ${versions.length}.` }],
      details: { versions: versions.map((v) => ({ date: v.date, label: v.label })) },
    };
  }

  const versionBody = fs.readFileSync(selectedVersion.fullPath, "utf-8");

  if (params.preview) {
    const diff = simpleDiff(currentBody, versionBody);
    return {
      content: [{ type: "text" as const, text: `## Preview: ${pagePath} (${selectedVersion.label})\n\n${diff}` }],
      details: { preview: true, version: selectedVersion, diff },
    };
  }

  // Restaura: escreve versão antiga como página atual
  deps.pageStore.writePage({
    path: pagePath.replace(/\.md$/, ""),
    title: extractTitle(versionBody) || `Restored: ${pagePath}`,
    body: versionBody,
    type: "lesson",
    scope,
    projectId: scope === "global" ? null : deps.projectId,
    tags: ["restored"],
    supersedes: pagePath,
  });

  return {
    content: [{ type: "text" as const, text: `Restored ${pagePath} from ${selectedVersion.label}.` }],
    details: { action: "restored", version: selectedVersion },
  };
}

async function handleGitRestore(
  deps: RestoreDeps,
  pagePath: string,
  projectId: string,
  params: { version?: number; date?: string; preview?: boolean },
  currentBody: string,
) {
  if (!deps.gitLayer) {
    return {
      content: [{ type: "text" as const, text: "Git versioning is not enabled for this wiki." }],
      details: { error: "git not enabled" },
    };
  }

  const fullPath = deps.pageStore["writer"]?.resolvePath(
    projectId === "_global" ? "global" : "project",
    projectId,
    pagePath,
  );

  // Busca log
  const log = deps.gitLayer.log(fullPath, 20);
  if (log.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No git history found for ${pagePath}.` }],
      details: { log: [] },
    };
  }

  if (params.preview) {
    return {
      content: [{ type: "text" as const, text: `## Git History for ${pagePath}\n\n${log.map((l) => `- ${l.date}: ${l.message} (${l.hash.slice(0, 7)})`).join("\n")}` }],
      details: { log },
    };
  }

  // Restaura
  try {
    const fullPath = deps.pageStore["writer"]?.resolvePath(
      projectId === "_global" ? "global" : "project",
      projectId,
      pagePath,
    );
    deps.gitLayer.restore(fullPath, `HEAD~${params.version ?? 1}`);
    return {
      content: [{ type: "text" as const, text: `Restored ${pagePath} from git history.` }],
      details: { action: "restored", source: "git" },
    };
  } catch {
    return {
      content: [{ type: "text" as const, text: `Failed to restore ${pagePath} from git.` }],
      details: { error: "git restore failed" },
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function listSupersededVersions(
  deps: RestoreDeps,
  projectId: string,
  pagePath: string,
  scope: "project" | "global",
): SupersededVersion[] {
  const fullPath = resolveFullPath(deps, projectId, pagePath, scope);
  const dir = path.dirname(fullPath);
  const supersededDir = path.join(dir, ".superseded");
  const baseName = path.basename(pagePath, ".md");

  if (!fs.existsSync(supersededDir)) return [];

  const files = fs
    .readdirSync(supersededDir)
    .filter((f) => f.startsWith(baseName + "-") && f.endsWith(".md"))
    .sort()
    .reverse(); // mais recente primeiro

  return files.map((f) => {
    const datePart = f.slice(baseName.length + 1, -3); // "foo-2026-07-29.md" → "2026-07-29"
    return {
      date: datePart.replace(/T.*/, ""),
      fullPath: path.join(supersededDir, f),
      label: datePart,
    };
  });
}

function resolveFullPath(
  deps: RestoreDeps,
  projectId: string,
  pagePath: string,
  scope: "project" | "global",
): string {
  const wikiRoot = path.join(deps.wikiRoot, scope === "global" ? "_global" : "projects", projectId);
  return path.join(wikiRoot, pagePath);
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "";
}

function simpleDiff(a: string, b: string): string {
  const linesA = a.split("\n");
  const linesB = b.split("\n");

  const maxLen = Math.min(20, Math.max(linesA.length, linesB.length));
  const parts: string[] = [];

  for (let i = 0; i < Math.min(maxLen, linesA.length, linesB.length); i++) {
    if (linesA[i] !== linesB[i]) {
      parts.push(`- ${linesA[i]}`);
      parts.push(`+ ${linesB[i]}`);
    }
  }

  if (parts.length === 0) {
    // Mostra primeiras linhas se idênticas
    parts.push("(files are identical in the first shown lines)");
  }

  return parts.join("\n");
}
