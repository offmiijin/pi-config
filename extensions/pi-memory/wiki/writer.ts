/**
 * WikiWriter — Primitiva de escrita atômica no diretório wiki.
 *
 * Responsável por:
 *   - Escrever arquivos .md com atomicidade (tmp + rename + fsync)
 *   - Mover para .superseded/ em caso de sobrescrita
 *   - Resolver path por escopo (project vs global)
 *   - Ler páginas do disco
 *
 * Cross-runtime: Bun e Node.js (node:fs puro).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter, buildFrontmatter, validateFrontmatter } from "./frontmatter";
import type { Frontmatter } from "./frontmatter";

// ── Config ─────────────────────────────────────────────────────────────

export interface WikiWriterConfig {
  /** Diretório raiz do wiki (ex: ~/.pi/agent/memory/wiki/) */
  rootDir: string;
  /** Número máximo de versões em .superseded/ (default: 10) */
  maxSupersededVersions?: number;
}

const DEFAULTS = {
  maxSupersededVersions: 10,
};

// ── WikiWriter ─────────────────────────────────────────────────────────

export class WikiWriter {
  private readonly rootDir: string;
  private readonly maxSuperseded: number;

  constructor(config: WikiWriterConfig) {
    this.rootDir = path.resolve(config.rootDir);
    this.maxSuperseded = config.maxSupersededVersions ?? DEFAULTS.maxSupersededVersions;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  // ── Path resolution ──────────────────────────────────────────────

  /**
   * Resolve o path completo no sistema de arquivos a partir do escopo.
   *
   * scope=project → wiki/projects/<projectId>/<path>
   * scope=global  → wiki/_global/<path>
   *
   * @param scope - Escopo da página
   * @param projectId - Hash do projeto (ignorado se scope=global)
   * @param pagePath - Path relativo (ex: "decisions/foo.md")
   * @returns Path absoluto no sistema de arquivos
   */
  resolvePath(scope: "project" | "global", projectId: string | null, pagePath: string): string {
    const normalized = pagePath.replace(/\\/g, "/").replace(/^\/+/, "");

    if (scope === "global") {
      return path.join(this.rootDir, "_global", normalized);
    }

    const pid = projectId || "default";
    return path.join(this.rootDir, "projects", pid, normalized);
  }

  /**
   * Verifica se uma página existe no disco.
   */
  pageExists(scope: "project" | "global", projectId: string | null, pagePath: string): boolean {
    const fullPath = this.resolvePath(scope, projectId, pagePath);
    return fs.existsSync(fullPath);
  }

  // ── Write ────────────────────────────────────────────────────────

  /**
   * Escreve uma página markdown no wiki com atomicidade.
   *
   * Se o path já existe, a versão atual é movida para .superseded/
   * antes da nova versão ser escrita.
   *
   * @returns Path absoluto do arquivo escrito
   */
  writePage(
    scope: "project" | "global",
    projectId: string | null,
    pagePath: string,
    frontmatter: Frontmatter,
    body: string,
  ): string {
    const fullPath = this.resolvePath(scope, projectId, pagePath);

    // Se já existe, move para .superseded/
    if (fs.existsSync(fullPath)) {
      this.moveToSuperseded(fullPath);
    }

    // Garante diretório pai
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });

    // Monta markdown completo
    const content = buildFrontmatter(frontmatter, body);

    // Atomic write: tmp + rename + fsync
    const tmpPath = fullPath + ".tmp." + randomUUID().slice(0, 8);
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, fullPath);
      this.fsyncDir(dir);
    } catch (err) {
      // Cleanup tmp em caso de erro
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignora */ }
      throw new Error(
        `Falha ao escrever página ${pagePath}: ${(err as Error).message}`,
      );
    }

    return fullPath;
  }

  /**
   * Move uma página existente para .superseded/.
   *
   * O filename recebe sufixo da data:
   *   foo.md → .superseded/foo-2026-07-29.md
   *
   * Se já existe .superseded/ com mesma data, append hora:
   *   foo-2026-07-29T12-00-00.md
   *
   * Mantém no máximo `maxSupersededVersions` versões.
   */
  private moveToSuperseded(fullPath: string): void {
    const dir = path.dirname(fullPath);
    const supersededDir = path.join(dir, ".superseded");
    fs.mkdirSync(supersededDir, { recursive: true });

    const baseName = path.basename(fullPath, ".md");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const targetName = `${baseName}-${timestamp}.md`;
    const targetPath = path.join(supersededDir, targetName);

    fs.renameSync(fullPath, targetPath);

    // Limpa versões excedentes
    this.pruneSuperseded(dir, baseName);
  }

  /**
   * Remove versões excedentes em .superseded/, mantendo as N mais recentes.
   */
  private pruneSuperseded(dir: string, baseName: string): void {
    const supersededDir = path.join(dir, ".superseded");
    if (!fs.existsSync(supersededDir)) return;

    const files = fs
      .readdirSync(supersededDir)
      .filter((f) => f.startsWith(baseName + "-") && f.endsWith(".md"))
      .sort()
      .reverse(); // mais recente primeiro

    if (files.length <= this.maxSuperseded) return;

    const toRemove = files.slice(this.maxSuperseded);
    for (const file of toRemove) {
      try {
        fs.unlinkSync(path.join(supersededDir, file));
      } catch { /* best-effort */ }
    }
  }

  // ── Delete ───────────────────────────────────────────────────────

  /**
   * Deleta (move para .superseded/) uma página do wiki.
   */
  deletePage(scope: "project" | "global", projectId: string | null, pagePath: string): void {
    const fullPath = this.resolvePath(scope, projectId, pagePath);

    if (!fs.existsSync(fullPath)) {
      return; // idempotente
    }

    this.moveToSuperseded(fullPath);
  }

  // ── Read ─────────────────────────────────────────────────────────

  /**
   * Lê uma página do disco e retorna frontmatter + body.
   *
   * @returns Frontmatter + body, ou null se arquivo não existe
   */
  readPage(scope: "project" | "global", projectId: string | null, pagePath: string): { frontmatter: Frontmatter; body: string } | null {
    const fullPath = this.resolvePath(scope, projectId, pagePath);

    if (!fs.existsSync(fullPath)) return null;

    const content = fs.readFileSync(fullPath, "utf-8");
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      // Arquivo sem frontmatter → não é uma página válida do wiki
      return null;
    }

    return parsed;
  }

  /**
   * Lê apenas o body bruto de uma página (sem parse).
   * Útil para rebuild de índice ou diff.
   */
  readRaw(fullPath: string): string | null {
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, "utf-8");
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Força flush do diretório no disco (fsync).
   * Garante que o rename seja persistido mesmo em crash.
   */
  private fsyncDir(dirPath: string): void {
    try {
      const fd = fs.openSync(dirPath, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch {
      // fsync de diretório pode falhar em alguns sistemas (ex: Windows)
      // Não crítico — o dado já foi escrito.
    }
  }

  /**
   * Sobrescreve página existente atomicamente, sem mover para .superseded/.
   * Usado para atualizações de metadados (confidence, status) que não
   * justificam versionamento.
   *
   * Se o arquivo não existe, cria normalmente.
   */
  updatePageInPlace(
    scope: "project" | "global",
    projectId: string | null,
    pagePath: string,
    content: string,
  ): string {
    const fullPath = this.resolvePath(scope, projectId, pagePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = fullPath + ".tmp." + randomUUID().slice(0, 8);
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, fullPath);
      this.fsyncDir(dir);
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignora */ }
      throw new Error(
        `Falha ao atualizar página ${pagePath}: ${(err as Error).message}`,
      );
    }

    return fullPath;
  }

  /**
   * Retorna o diretório raiz do wiki.
   */
  getRootDir(): string {
    return this.rootDir;
  }
}
