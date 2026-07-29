/**
 * Indexer — Walk recursivo no wiki/ que popula a tabela pages.
 *
 * wiki/ é a fonte da verdade. SQLite (pages) é o índice derivado.
 * O Indexer mantém os dois sincronizados.
 *
 * Cross-runtime: Bun e Node.js (node:fs puro).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parseFrontmatter } from "./frontmatter";
import type { Frontmatter } from "./frontmatter";
import type { Page } from "../types";
import type { IStorage } from "../storage/index";

// ── Config ─────────────────────────────────────────────────────────────

export interface IndexerConfig {
  /** Diretório raiz do wiki */
  wikiRoot: string;
  /** Storage SQLite (implementa IStorage) */
  storage: IStorage;
}

export interface IndexResult {
  total: number;
  indexed: number;
  skipped: number;
  deleted: number;
  errors: number;
  durationMs: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Rotas de escopo para path absoluto no wiki. */
function isGlobalPage(filePath: string, wikiRoot: string): boolean {
  const rel = path.relative(wikiRoot, filePath).replace(/\\/g, "/");
  return rel.startsWith("_global/");
}

function extractProjectId(filePath: string, wikiRoot: string): string | null {
  const rel = path.relative(wikiRoot, filePath).replace(/\\/g, "/");
  // projects/<projectId>/...
  const match = rel.match(/^projects\/([^/]+)\//);
  return match ? match[1] : null;
}

function extractPagePath(filePath: string, wikiRoot: string): string {
  const rel = path.relative(wikiRoot, filePath).replace(/\\/g, "/");
  // Remove "projects/<id>/" ou "_global/" do início
  const withoutProject = rel.replace(/^(projects\/[^/]+\/|_global\/)/, "");
  return withoutProject;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Walk recursivo ignorando .superseded/ e diretórios ocultos. */
function walkMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith(".")) continue; // ocultos .superseded/, .git
    if (entry.isDirectory()) {
      results.push(...walkMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Indexer ────────────────────────────────────────────────────────────

export class Indexer {
  private readonly wikiRoot: string;
  private readonly storage: IStorage;

  constructor(config: IndexerConfig) {
    this.wikiRoot = path.resolve(config.wikiRoot);
    this.storage = config.storage;
  }

  /**
   * Scan incremental: compara mtime + sha256 vs SQLite.
   * Só indexa páginas modificadas.
   */
  scanIncremental(): IndexResult {
    const start = Date.now();
    const result: IndexResult = { total: 0, indexed: 0, skipped: 0, deleted: 0, errors: 0, durationMs: 0 };

    try {
      const files = walkMdFiles(this.wikiRoot);
      result.total = files.length;

      const indexedPaths = new Set<string>();

      for (const filePath of files) {
        try {
          const stat = fs.statSync(filePath);

          // Determina scope e projectId
          const scope = isGlobalPage(filePath, this.wikiRoot) ? "global" : "project";
          const projectId = isGlobalPage(filePath, this.wikiRoot)
            ? "_global"
            : extractProjectId(filePath, this.wikiRoot) || "default";
          const pagePath = extractPagePath(filePath, this.wikiRoot);

          // Verifica se precisa atualizar
          const existing = this.storage.getPage(projectId, pagePath);
          if (existing && existing.mtime === stat.mtimeMs && existing.content_hash) {
            const content = fs.readFileSync(filePath, "utf-8");
            if (sha256(content) === existing.content_hash) {
              result.skipped++;
              indexedPaths.add(`${projectId}:${pagePath}`);
              continue;
            }
          }

          // Indexa
          this.indexFile(filePath, scope, projectId, pagePath, stat.mtimeMs);
          result.indexed++;
          indexedPaths.add(`${projectId}:${pagePath}`);
        } catch {
          result.errors++;
        }
      }

      // Deleta páginas que não existem mais no disco
      const allProjectIds = this.collectProjectIds();
      for (const pid of allProjectIds) {
        const pages = this.storage.getPagesByProject(pid);
        for (const page of pages) {
          const key = `${page.project_id}:${page.path}`;
          if (!indexedPaths.has(key)) {
            this.storage.deletePage(page.project_id, page.path);
            result.deleted++;
          }
        }
      }
    } catch {
      result.errors++;
    }

    result.durationMs = Date.now() - start;
    return result;
  }

  /**
   * Scan completo: apaga pages e reindexa tudo.
   */
  scanFull(): IndexResult {
    const start = Date.now();
    const result: IndexResult = { total: 0, indexed: 0, skipped: 0, deleted: 0, errors: 0, durationMs: 0 };

    try {
      const files = walkMdFiles(this.wikiRoot);
      result.total = files.length;

      // Apaga pages existentes (limpeza total)
      const allProjectIds = this.collectProjectIds();
      for (const pid of allProjectIds) {
        const pages = this.storage.getPagesByProject(pid);
        for (const page of pages) {
          this.storage.deletePage(page.project_id, page.path);
          result.deleted++;
        }
      }

      // Reindexa tudo
      for (const filePath of files) {
        try {
          const stat = fs.statSync(filePath);
          const scope = isGlobalPage(filePath, this.wikiRoot) ? "global" : "project";
          const projectId = isGlobalPage(filePath, this.wikiRoot)
            ? "_global"
            : extractProjectId(filePath, this.wikiRoot) || "default";
          const pagePath = extractPagePath(filePath, this.wikiRoot);

          this.indexFile(filePath, scope, projectId, pagePath, stat.mtimeMs);
          result.indexed++;
        } catch {
          result.errors++;
        }
      }
    } catch {
      result.errors++;
    }

    result.durationMs = Date.now() - start;
    return result;
  }

  /**
   * Indexa um único arquivo .md em uma linha da tabela pages.
   */
  private indexFile(
    filePath: string,
    scope: "project" | "global",
    projectId: string,
    pagePath: string,
    mtimeMs: number,
  ): void {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      // Arquivo sem frontmatter → não é página válida
      return;
    }

    const { frontmatter, body } = parsed;
    const hash = sha256(content);
    const now = Date.now();

    const page: Page = {
      id: randomUUID(),
      project_id: projectId,
      path: pagePath,
      title: frontmatter.title,
      body,
      type: frontmatter.type as Page["type"],
      scope,
      tags: frontmatter.tags,
      confidence: frontmatter.confidence,
      status: frontmatter.status,
      pinned: frontmatter.pinned,
      supersedes: frontmatter.supersedes ?? null,
      created_at: frontmatter.created ? new Date(frontmatter.created).getTime() : now,
      updated_at: frontmatter.updated ? new Date(frontmatter.updated).getTime() : now,
      content_hash: hash,
      mtime: mtimeMs,
    };

    const existing = this.storage.getPage(projectId, pagePath);
    if (existing) {
      page.id = existing.id; // mantém mesmo ID
      this.storage.updatePage(page);
    } else {
      this.storage.insertPage(page);
    }
  }

  /**
   * Coleta todos os project IDs que existem no índice.
   */
  private collectProjectIds(): string[] {
    const ids = new Set<string>();

    // Walk nos diretórios do wiki
    const projectsDir = path.join(this.wikiRoot, "projects");
    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          ids.add(entry.name);
        }
      }
    }

    // Sempre inclui _global
    ids.add("_global");

    return [...ids];
  }
}
