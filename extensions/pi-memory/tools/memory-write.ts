/**
 * Tool: memory_write
 *
 * Escreve uma página markdown no wiki.
 * LLM usa para salvar decisões, preferências, lições, padrões.
 *
 * Parâmetros novos (v2):
 *   path?, title, body, type, scope, tags?, pinned?, supersedes?
 *
 * Backward compat (v1):
 *   text → body (título truncado do texto)
 *   scope: "user" | "session" → "project"
 */

import { Type } from "typebox";
import type { PageType, PageScope } from "../types";
import type { PageStore, WritePageParams } from "../storage/page-store";

// ── Helpers ────────────────────────────────────────────────────────────

function truncateTitle(text: string, maxLen = 80): string {
  const cleaned = text.replace(/[#*_`]/g, "").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "…" : cleaned;
}

function migrateScope(oldScope: string): PageScope {
  if (oldScope === "global") return "global";
  return "project"; // user e session viram project
}

// ── Tool factory ───────────────────────────────────────────────────────

export function createMemoryWriteTool(
  pageStore: PageStore,
  projectId: string,
) {
  return {
    name: "memory_write",
    label: "Memory: Write",
    description:
      "Write a decision, preference, lesson, pattern, or fact as a wiki page. " +
      "Use this to save information that persists across sessions. " +
      "Provide a descriptive title and the full body in markdown. " +
      "For cross-project preferences, use scope: 'global'.",

    parameters: Type.Object({
      path: Type.Optional(Type.String({
        description: "Optional path (ex: 'decisions/hexagonal-arch'). Auto-generated from title if omitted.",
      })),
      title: Type.String({
        description: "Page title. Be descriptive but concise (used as filename).",
      }),
      body: Type.String({
        description: "Page body in markdown (without frontmatter).",
      }),
      type: Type.Union(
        [
          Type.Literal("decision"),
          Type.Literal("preference"),
          Type.Literal("lesson"),
          Type.Literal("pattern"),
          Type.Literal("fact"),
        ],
        { description: "Type of page" }
      ),
      scope: Type.Optional(
        Type.Union(
          [Type.Literal("project"), Type.Literal("global")],
          { description: "Scope: project (default) or global (cross-project)", default: "project" }
        )
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tags for categorization (e.g., [\"architecture\", \"pnpm\"])",
        })
      ),
      pinned: Type.Optional(
        Type.Boolean({ description: "Pin page (immune to decay/pruning)", default: false })
      ),
      supersedes: Type.Optional(
        Type.String({ description: "Path of the page this replaces (ex: 'decisions/old-arch.md')" })
      ),
      // Backward compat: parâmetro text da v1
      text: Type.Optional(Type.String({
        description: "[DEPRECATED] Use body + title instead. Converted automatically.",
      })),
    }),

    async execute(
      _toolCallId: string,
      params: {
        path?: string;
        title?: string;
        body?: string;
        text?: string;
        type: PageType;
        scope?: string;
        tags?: string[];
        pinned?: boolean;
        supersedes?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      // ── Backward compat ─────────────────────────────────────────
      const body = params.body || params.text || "";
      const title = params.title || truncateTitle(body);

      if (!body) {
        return {
          content: [{ type: "text" as const, text: "Error: body or text is required." }],
          details: { error: "body or text required" },
        };
      }

      if (!params.type) {
        return {
          content: [{ type: "text" as const, text: "Error: type is required (decision, preference, lesson, pattern, fact)." }],
          details: { error: "type required" },
        };
      }

      const scope = migrateScope(params.scope || "project");

      try {
        const writeParams: WritePageParams = {
          path: params.path,
          title,
          body,
          type: params.type,
          scope,
          projectId: scope === "global" ? null : projectId,
          tags: params.tags,
          pinned: params.pinned,
          supersedes: params.supersedes,
        };

        const result = pageStore.writePage(writeParams);

        return {
          content: [
            {
              type: "text" as const,
              text: `Page saved: ${result.title} (${result.path})`,
            },
          ],
          details: {
            action: result.path.includes("-2") || result.path.includes("-3") ? "created_with_conflict_resolution" : "created",
            id: result.id,
            path: result.path,
            scope: result.scope,
            projectId: result.projectId,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error saving page: ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}
