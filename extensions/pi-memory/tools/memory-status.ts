/**
 * Tool: memory_status
 *
 * Estatísticas do sistema de memória (páginas wiki + observações).
 * Adaptada para o novo modelo baseado em páginas markdown.
 */

import { Type } from "typebox";
import type { IStorage } from "../storage/index";
import type { GitLayer } from "../wiki/git-layer";
import type { PageStore } from "../storage/page-store";
import type { PageType, PageScope } from "../types";

export interface StatusDeps {
  storage: IStorage;
  pageStore: PageStore | null;
  gitLayer: GitLayer | null;
}

export function createMemoryStatusTool(deps: StatusDeps) {
  return {
    name: "memory_status",
    label: "Memory: Status",
    description:
      "Show persistent memory statistics: total pages, breakdown by type/scope, " +
      "average confidence, pinned pages, pending observations, git status.",

    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const lines: string[] = [];
      const storage = deps.storage;

      // ── Pages ─────────────────────────────────────────────────────
      const totalPages = storage.countPages();
      const allProjects = collectProjectIds(deps);
      let totalByType: Record<string, number> = {};
      let totalByScope: Record<string, number> = {};
      let totalPinned = 0;
      let totalConfidence = 0;
      let pagesWithConfidence = 0;

      for (const pid of allProjects) {
        const pages = storage.getPagesByProject(pid);
        for (const page of pages) {
          totalByType[page.type] = (totalByType[page.type] || 0) + 1;
          totalByScope[page.scope] = (totalByScope[page.scope] || 0) + 1;
          if (page.pinned) totalPinned++;
          totalConfidence += page.confidence;
          pagesWithConfidence++;
        }
      }

      const avgConfidence = pagesWithConfidence > 0
        ? (totalConfidence / pagesWithConfidence).toFixed(2)
        : "N/A";

      lines.push(`📄 **Pages**: ${totalPages}`);
      lines.push(`   By type: ${formatBreakdown(totalByType)}`);
      lines.push(`   By scope: ${formatBreakdown(totalByScope)}`);
      lines.push(`   Avg confidence: ${avgConfidence}`);
      lines.push(`   Pinned: ${totalPinned}`);

      // ── Observations ──────────────────────────────────────────────
      const totalObs = storage.countObservations();
      const pendingExt = storage.countPendingExtraction();
      lines.push(`📝 **Observations**: ${totalObs} (${pendingExt} pending extraction)`);

      // ── Git status ────────────────────────────────────────────────
      if (deps.gitLayer) {
        const gitStatus = deps.gitLayer.status;
        if (gitStatus.available) {
          lines.push(`🔧 **Git**: ${gitStatus.branch}${gitStatus.dirty ? " (dirty)" : " (clean)"}`);
        }
      }

      // ── Operations (desde o início da sessão) ──────────────────────
      // Nota: operações agora são pages-based, mas mantemos compat
      lines.push("💡 Use `memory_search` to find pages, `memory_restore_page` to undo changes.");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          total_pages: totalPages,
          by_type: totalByType,
          by_scope: totalByScope,
          avg_confidence: avgConfidence,
          pinned_pages: totalPinned,
          total_observations: totalObs,
          pending_extraction: pendingExt,
        },
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function collectProjectIds(deps: StatusDeps): string[] {
  const ids = new Set<string>();
  ids.add("_global");
  try {
    // Tenta listar projetos do wiki
    const wikiRoot = deps.pageStore?.["writer"]?.["rootDir"];
    if (wikiRoot) {
      const projectsDir = require("node:path").join(wikiRoot, "projects");
      if (require("node:fs").existsSync(projectsDir)) {
        const entries = require("node:fs").readdirSync(projectsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            ids.add(entry.name);
          }
        }
      }
    }
  } catch {
    // fallback
  }
  return [...ids];
}

function formatBreakdown(record: Record<string, number>): string {
  return Object.entries(record)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ") || "none";
}
