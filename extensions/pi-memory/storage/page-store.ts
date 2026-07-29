/**
 * PageStore — Orquestrador de escrita/leitura de páginas markdown.
 *
 * Coordena:
 *   1. WikiWriter: escreve .md no disco (fonte da verdade)
 *   2. SqliteStore: atualiza índice pages + pages_fts
 *   3. GitLayer: versionamento opcional (futuro)
 *
 * O write path é:
 *   WikiWriter.writePage() → SqliteStore.insertPage()/updatePage()
 *
 * O read path é:
 *   SqliteStore.searchPagesFts() → WikiWriter.readPage() (se precisar do body completo)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { WikiWriter } from "../wiki/writer";
import { GitLayer } from "../wiki/git-layer";
import type { GitLayerConfig } from "../wiki/git-layer";
import { slugifyPathByType, resolveUniquePath } from "../wiki/slugify";
import { buildFrontmatter } from "../wiki/frontmatter";
import type { Frontmatter } from "../wiki/frontmatter";
import type { Page, PageType, PageScope, RetrievalResult } from "../types";
import type { IStorage } from "./index";

// ── Write params ───────────────────────────────────────────────────────

export interface WritePageParams {
  /** Path relativo (ex: "decisions/hexagonal-arch"). Se omitido, gerado do title */
  path?: string;
  /** Título da página */
  title: string;
  /** Corpo markdown (sem frontmatter) */
  body: string;
  /** Tipo da página */
  type: PageType;
  /** Escopo: project ou global */
  scope: "project" | "global";
  /** Hash do projeto (obrigatório se scope=project) */
  projectId?: string | null;
  /** Tags */
  tags?: string[];
  /** Confiança (0-1, default 0.5) */
  confidence?: number;
  /** Pinned? (imune a decay/pruning) */
  pinned?: boolean;
  /** Path da página anterior que esta substitui */
  supersedes?: string;
}

export interface PageInfo {
  id: string;
  path: string;        // path relativo (ex: "decisions/foo.md")
  fullPath: string;    // path absoluto no disco
  projectId: string;
  title: string;
  type: PageType;
  scope: PageScope;
}

// ── PageStore ──────────────────────────────────────────────────────────

export class PageStore {
  private readonly writer: WikiWriter;
  private readonly gitLayer: GitLayer;
  private readonly storage: IStorage;

  constructor(wikiRoot: string, storage: IStorage, gitConfig?: GitLayerConfig) {
    this.writer = new WikiWriter({ rootDir: wikiRoot });
    this.gitLayer = new GitLayer(wikiRoot, gitConfig ?? { enabled: false });
    this.storage = storage;
    this.gitLayer.init();
  }

  /**
   * Escreve (ou atualiza) uma página markdown.
   *
   * Fluxo:
   *   1. Determina path (slugify se omitido, resolve conflitos)
   *   2. Monta frontmatter com timestamps
   *   3. WikiWriter.writePage() → .md no disco
   *   4. SQLite: insertPage() ou updatePage()
   *   5. Retorna PageInfo
   */
  writePage(params: WritePageParams): PageInfo {
    const projectId = params.scope === "global" ? "_global" : (params.projectId || "default");

    // 1. Determina path
    let pagePath = params.path
      ? params.path.replace(/\.md$/, "") + ".md"
      : slugifyPathByType(params.type, params.title);

    // 2. Resolve conflitos
    const existingPaths = this.collectExistingPaths(projectId);
    pagePath = resolveUniquePath(pagePath, existingPaths);

    // 3. Monta frontmatter
    const now = new Date().toISOString();
    const existingPage = this.storage.getPage(projectId, pagePath);
    const created = existingPage ? existingPage.created_at : Date.now();
    const updated = Date.now();

    const fm: Frontmatter = {
      type: params.type,
      scope: params.scope,
      title: params.title,
      tags: params.tags || [],
      confidence: params.confidence ?? 0.5,
      status: "active",
      pinned: params.pinned ?? false,
      supersedes: params.supersedes,
      created: new Date(created).toISOString(),
      updated: new Date(updated).toISOString(),
    };

    // 4. Escreve .md no disco
    const fullPath = this.writer.writePage(params.scope, projectId, pagePath, fm, params.body);

    // 5. Lê de volta pra pegar o content_hash real
    const written = fs.readFileSync(fullPath, "utf-8");
    const contentHash = createHash("sha256").update(written).digest("hex");
    const mtime = fs.statSync(fullPath).mtimeMs;

    // 5b. Git: stage (commit implícito via batch ou imediato)
    this.gitLayer.stage(fullPath);

    // 6. Atualiza SQLite
    const page: Page = {
      id: existingPage?.id ?? randomUUID(),
      project_id: projectId,
      path: pagePath,
      title: params.title,
      body: params.body,
      type: params.type,
      scope: params.scope,
      tags: params.tags || [],
      confidence: params.confidence ?? 0.5,
      status: "active",
      pinned: params.pinned ?? false,
      supersedes: params.supersedes ?? null,
      created_at: created,
      updated_at: updated,
      content_hash: contentHash,
      mtime,
    };

    if (existingPage) {
      this.storage.updatePage(page);
    } else {
      this.storage.insertPage(page);
    }

    return {
      id: page.id,
      path: pagePath,
      fullPath,
      projectId,
      title: params.title,
      type: params.type,
      scope: params.scope,
    };
  }

  /**
   * Lê uma página (markdown completo) do disco.
   */
  readPage(projectId: string, pagePath: string): { frontmatter: Frontmatter; body: string } | null {
    const scope = projectId === "_global" ? "global" : "project";
    return this.writer.readPage(scope, projectId, pagePath);
  }

  /**
   * Deleta uma página (move para .superseded/ + remove do índice).
   */
  deletePage(projectId: string, pagePath: string): void {
    const scope = projectId === "_global" ? "global" : "project";
    const fullPath = this.writer.resolvePath(scope, projectId, pagePath);
    this.writer.deletePage(scope, projectId, pagePath);
    this.storage.deletePage(projectId, pagePath);
    this.gitLayer.stage(fullPath);
  }

  /**
   * Busca páginas via FTS5.
   * Se projectId for específico, inclui páginas globais (_global).
   */
  searchPages(query: string, projectId: string | null, topK = 10): RetrievalResult[] {
    return this.storage.searchPagesFts(query, projectId, topK);
  }

  /**
   * Atualiza metadados (confidence, status) de uma página existente.
   *
   * Diferente de writePage(), NÃO move a versão anterior para .superseded/
   * e NÃO requer title/body — apenas reescreve o frontmatter in-place.
   * Usado por SweepConsolidator (decay/pruning) para manter wiki ↔ SQLite
   * consistentes sem gerar versionamento excessivo.
   */
  updatePageMetadata(
    projectId: string,
    pagePath: string,
    updates: { confidence?: number; status?: string },
  ): void {
    const scope = projectId === "_global" ? "global" : "project";
    const current = this.writer.readPage(scope, projectId, pagePath);
    if (!current) return;

    const newFm = { ...current.frontmatter };
    if (updates.confidence !== undefined) {
      newFm.confidence = updates.confidence;
    }
    if (updates.status !== undefined) {
      newFm.status = updates.status as import("../wiki/frontmatter").PageStatus;
    }
    newFm.updated = new Date().toISOString();

    const newContent = buildFrontmatter(newFm, current.body);
    const fullPath = this.writer.updatePageInPlace(scope, projectId, pagePath, newContent);

    // Atualiza SQLite
    const mtime = fs.statSync(fullPath).mtimeMs;
    const contentHash = createHash("sha256").update(newContent).digest("hex");
    const existing = this.storage.getPage(projectId, pagePath);
    if (existing) {
      const updated: Page = {
        ...existing,
        confidence: updates.confidence ?? existing.confidence,
        status: (updates.status as Page["status"]) ?? existing.status,
        updated_at: Date.now(),
        content_hash: contentHash,
        mtime,
      };
      this.storage.updatePage(updated);
    }
  }

  /**
   * Coleta paths existentes para resolução de conflitos.
   */
  private collectExistingPaths(projectId: string): Set<string> {
    const pages = this.storage.getPagesByProject(projectId);
    return new Set(pages.map((p) => p.path));
  }
}


