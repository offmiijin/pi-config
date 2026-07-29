/**
 * SessionLogger — Geração de páginas de sessão markdown.
 *
 * Cada sessão do pi gera uma página em:
 *   wiki/projects/<hash>/sessions/YYYY-MM-DD/NNN-slug.md
 *
 * O slug é extraído do primeiro user prompt da sessão.
 * Turnos "ricos" (bash/edit/write) geram entradas cronológicas.
 * Session shutdown finaliza e persiste a página.
 *
 * Cross-runtime: Bun e Node.js.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugify } from "../wiki/slugify";
import { buildFrontmatter } from "../wiki/frontmatter";
import { WikiWriter } from "../wiki/writer";
import type { Frontmatter } from "../wiki/frontmatter";
import type { Page } from "../types";
import type { IStorage } from "../storage/index";
import type { GitLayerConfig } from "../wiki/git-layer";

// ── Tipos ──────────────────────────────────────────────────────────────

export interface TurnInfo {
  timestamp: number;
  label: string;           // "Setup", "Implementação", "Correção", etc.
  toolResults: ToolResultEntry[];
}

export interface ToolResultEntry {
  toolName: string;
  command?: string;
  outcome: "success" | "error";
  filesTouched: string[];
  summary: string;         // preview do resultado (primeiros 200 chars)
}

export interface SessionInfo {
  sessionId: string;
  slug: string;
  date: string;            // YYYY-MM-DD
  pagePath: string;        // relativo (ex: "sessions/2026-07-29/001-refactor-auth.md")
  fullPath: string;        // absoluto
  title: string;
}

// ── Config ─────────────────────────────────────────────────────────────

export interface SessionLoggerConfig {
  wikiRoot: string;
  storage: IStorage;
  projectId: string;
  gitConfig?: GitLayerConfig;
}

// ── SessionLogger ──────────────────────────────────────────────────────

export class SessionLogger {
  private readonly writer: WikiWriter;
  private readonly storage: IStorage;
  private readonly wikiRoot: string;
  private readonly projectId: string;

  private sessionInfo: SessionInfo | null = null;
  private turns: TurnInfo[] = [];
  private dirty = false;

  constructor(config: SessionLoggerConfig) {
    this.wikiRoot = config.wikiRoot;
    this.storage = config.storage;
    this.projectId = config.projectId;
    this.writer = new WikiWriter({ rootDir: config.wikiRoot });
  }

  /**
   * Inicializa a sessão: determina slug + path.
   * Chamado no session_start com o primeiro prompt do usuário.
   *
   * Se já existe sessão ativa (resume), retoma a mesma página.
   */
  initSession(sessionId: string, firstPrompt: string): SessionInfo {
    if (this.sessionInfo) return this.sessionInfo; // já inicializada

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const slug = slugify(firstPrompt || "session").slice(0, 40);
    const seqNumber = this.nextSequenceNumber(date);

    const pagePath = `sessions/${date}/${String(seqNumber).padStart(3, "0")}-${slug}.md`;
    const dir = path.dirname(pagePath);
    const title = `Sessão ${date} - ${firstPrompt.slice(0, 60)}`;

    this.sessionInfo = {
      sessionId,
      slug,
      date,
      pagePath,
      fullPath: path.join(this.projectDir(), pagePath),
      title,
    };

    return this.sessionInfo;
  }

  /**
   * Adiciona entrada de turno à sessão atual.
   * Turnos são acumulados em buffer até finalizeSession().
   */
  appendTurn(turnInfo: TurnInfo): void {
    if (!this.sessionInfo) return;
    this.turns.push(turnInfo);
    this.dirty = true;
  }

  /**
   * Finaliza a sessão: escreve página markdown + atualiza índice.
   * Chamado no session_shutdown.
   */
  finalizeSession(): SessionInfo | null {
    if (!this.sessionInfo) return this.sessionInfo;
    if (!this.dirty && this.sessionInfo) return this.sessionInfo;

    const { pagePath, title } = this.sessionInfo;
    const body = this.buildSessionBody();
    const now = Date.now();

    const fm: Frontmatter = {
      type: "session",
      scope: "project",
      title,
      tags: this.extractTags(),
      confidence: 1.0,
      status: "active",
      pinned: false,
      created: new Date(this.turns[0]?.timestamp ?? now).toISOString(),
      updated: new Date().toISOString(),
    };

    // 1. Escreve .md no disco
    const fullPath = this.writer.writePage("project", this.projectId, pagePath, fm, body);

    // 2. Atualiza SQLite diretamente
    const written = fs.readFileSync(fullPath, "utf-8");
    const contentHash = createHash("sha256").update(written).digest("hex");
    const mtime = fs.statSync(fullPath).mtimeMs;

    const existing = this.storage.getPage(this.projectId, pagePath);
    const page: Page = {
      id: existing?.id ?? randomUUID(),
      project_id: this.projectId,
      path: pagePath,
      title,
      body,
      type: "session",
      scope: "project",
      tags: this.extractTags(),
      confidence: 1.0,
      status: "active",
      pinned: false,
      supersedes: null,
      created_at: existing?.created_at ?? this.turns[0]?.timestamp ?? now,
      updated_at: now,
      content_hash: contentHash,
      mtime,
    };

    if (existing) {
      this.storage.updatePage(page);
    } else {
      this.storage.insertPage(page);
    }

    this.dirty = false;
    return this.sessionInfo;
  }

  /**
   * Retorna o path da página de sessão atual.
   */
  getSessionPagePath(): string | null {
    return this.sessionInfo?.pagePath ?? null;
  }

  /**
   * Retorna informações da sessão atual.
   */
  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }

  /**
   * Reseta o logger (para nova sessão).
   */
  reset(): void {
    this.sessionInfo = null;
    this.turns = [];
    this.dirty = false;
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Constrói o corpo markdown da página de sessão.
   */
  private buildSessionBody(): string {
    const parts: string[] = [];

    for (const turn of this.turns) {
      const time = new Date(turn.timestamp).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      });
      parts.push(`## ${time} - ${turn.label}`);

      for (const tr of turn.toolResults) {
        const icon = tr.outcome === "error" ? "❌" : "✅";
        const files = tr.filesTouched.length > 0
          ? ` (arquivos: ${tr.filesTouched.join(", ")})`
          : "";
        const cmd = tr.command ? ` \`${tr.command}\`` : "";
        parts.push(`- ${icon} \`${tr.toolName}\`${cmd}${files}`);
        if (tr.summary) {
          parts.push(`  - ${tr.summary}`);
        }
      }

      parts.push("");
    }

    return parts.join("\n").trim();
  }

  /**
   * Extrai tags da sessão baseado nos tool results.
   */
  private extractTags(): string[] {
    const tags = new Set<string>();

    for (const turn of this.turns) {
      for (const tr of turn.toolResults) {
        if (tr.toolName === "bash" && tr.command) {
          if (tr.command.includes("git ")) tags.add("git");
          if (tr.command.includes("pnpm ") || tr.command.includes("npm ")) tags.add("dependencies");
          if (tr.command.includes("test")) tags.add("tests");
          if (tr.command.includes("docker")) tags.add("docker");
          if (tr.command.includes("deploy")) tags.add("deploy");
        }
        if (tr.outcome === "error") tags.add("errors");
        if (tr.filesTouched.length > 0) tags.add("code");
      }
    }

    return [...tags];
  }

  /**
   * Determina o próximo número sequencial para uma data.
   */
  private nextSequenceNumber(date: string): number {
    const sessionsDir = path.join(this.projectDir(), "sessions", date);
    if (!fs.existsSync(sessionsDir)) return 1;

    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
    let max = 0;
    for (const file of files) {
      const match = file.match(/^(\d+)-/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  }

  /**
   * Diretório do projeto no wiki.
   */
  private projectDir(): string {
    return path.join(this.wikiRoot, "projects", this.projectId);
  }
}
