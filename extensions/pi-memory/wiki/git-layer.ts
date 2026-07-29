/**
 * GitLayer — Versionamento opcional do wiki via git.
 *
 * Inicializa repositório git em wiki/ se configurado.
 * Suporta:
 *   - Commit por página (imediato)
 *   - Commit batch (acumula mudanças, commit a cada N ms)
 *   - Log de histórico
 *   - Restore de versão anterior
 *
 * Cross-runtime: Bun e Node.js (child_process.exec).
 * Se git não estiver instalado, desabilita gracefulmente.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Config ─────────────────────────────────────────────────────────────

export interface GitLayerConfig {
  /** Ativar versionamento git? */
  enabled: boolean;
  /** Intervalo de batch commit em ms (default: 5min) */
  batchIntervalMs?: number;
  /** Commit imediato por página? (default: false = batch) */
  commitPerPage?: boolean;
  /** Nome do autor para commits */
  authorName?: string;
  /** Email do autor para commits */
  authorEmail?: string;
}

export interface CommitInfo {
  hash: string;
  date: string;
  message: string;
}

const DEFAULTS = {
  batchIntervalMs: 300_000,
  commitPerPage: false,
  authorName: "pi-memory",
  authorEmail: "pi@local",
};

// ── GitLayer ───────────────────────────────────────────────────────────

export class GitLayer {
  private readonly wikiRoot: string;
  private readonly config: Required<GitLayerConfig>;
  private gitAvailable: boolean | null = null; // null = não verificado ainda
  private batchBuffer: Set<string> = new Set();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchDirty = false;

  constructor(wikiRoot: string, config: GitLayerConfig) {
    this.wikiRoot = path.resolve(wikiRoot);
    this.config = {
      enabled: config.enabled,
      batchIntervalMs: config.batchIntervalMs ?? DEFAULTS.batchIntervalMs,
      commitPerPage: config.commitPerPage ?? DEFAULTS.commitPerPage,
      authorName: config.authorName ?? DEFAULTS.authorName,
      authorEmail: config.authorEmail ?? DEFAULTS.authorEmail,
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Inicializa repositório git se necessário.
   * Cria .gitignore interno para evitar commitar DB/config.
   */
  init(): void {
    if (!this.config.enabled) return;
    if (!this.checkGit()) return;

    const gitDir = path.join(this.wikiRoot, ".git");

    if (!fs.existsSync(gitDir)) {
      try {
        this.git("init");
        this.writeGitignore();
        this.git("add", ".gitignore");
        this.git("commit", "-m", "chore(wiki): Inicializa wiki");
      } catch {
        // Falha no init não deve quebrar o sistema
      }
    }
  }

  /**
   * Prepara arquivos para commit.
   * Se commitPerPage=true, commita imediatamente.
   * Se batch, acumula e agenda commit.
   */
  stage(paths: string | string[]): void {
    if (!this.config.enabled) return;
    if (!this.gitAvailable) return;

    const files = Array.isArray(paths) ? paths : [paths];

    if (this.config.commitPerPage) {
      // Commit imediato
      for (const file of files) {
        try {
          const relPath = path.relative(this.wikiRoot, path.resolve(this.wikiRoot, file));
          this.git("add", relPath);
          this.git("commit", "-m", this.buildMessage("file", relPath));
        } catch {
          // Best-effort
        }
      }
    } else {
      // Batch: acumula
      for (const file of files) {
        this.batchBuffer.add(file);
      }
      this.scheduleBatch();
    }
  }

  /**
   * Força commit de tudo que está no buffer.
   */
  flush(): void {
    if (!this.config.enabled) return;
    if (!this.gitAvailable) return;
    if (this.batchBuffer.size === 0 && !this.batchDirty) return;

    try {
      this.git("add", "-A");
      this.git("commit", "-m", this.buildMessage("batch", `${this.batchBuffer.size} files`));
      this.batchBuffer.clear();
      this.batchDirty = false;
    } catch {
      // Best-effort
    }
  }

  /**
   * Histórico de commits de um arquivo.
   */
  log(filePath?: string, count = 10): CommitInfo[] {
    if (!this.config.enabled || !this.gitAvailable) return [];

    try {
      const args = ["log", `--max-count=${count}`, "--format=%H|%ci|%s"];
      if (filePath) {
        args.push("--", path.relative(this.wikiRoot, path.resolve(this.wikiRoot, filePath)));
      }

      const output = this.git(...args);
      if (!output) return [];

      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, date, ...msgParts] = line.split("|");
          return { hash: hash || "", date: date || "", message: msgParts.join("|") || "" };
        });
    } catch {
      return [];
    }
  }

  /**
   * Restaura arquivo de uma versão anterior.
   */
  restore(filePath: string, rev = "HEAD~1"): void {
    if (!this.config.enabled) return;
    if (!this.gitAvailable) return;

    try {
      const relPath = path.relative(this.wikiRoot, path.resolve(this.wikiRoot, filePath));
      this.git("checkout", rev, "--", relPath);
    } catch {
      // Best-effort
    }
  }

  /**
   * Retorna informações do repositório.
   */
  get status(): { available: boolean; branch: string; dirty: boolean } {
    if (!this.config.enabled || !this.gitAvailable) {
      return { available: false, branch: "", dirty: false };
    }

    try {
      const branch = this.git("rev-parse", "--abbrev-ref", "HEAD")?.trim() || "";
      const status = this.git("status", "--porcelain")?.trim() || "";
      return { available: true, branch, dirty: status.length > 0 };
    } catch {
      return { available: false, branch: "", dirty: false };
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Executa comando git no diretório wiki.
   */
  private git(...args: string[]): string {
    const cmd = `git ${args.map((a) => this.escape(a)).join(" ")}`;
    try {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: this.config.authorName,
        GIT_AUTHOR_EMAIL: this.config.authorEmail,
        GIT_COMMITTER_NAME: this.config.authorName,
        GIT_COMMITTER_EMAIL: this.config.authorEmail,
      };
      return execSync(cmd, { cwd: this.wikiRoot, encoding: "utf-8", env, timeout: 10_000 }).trim();
    } catch {
      throw new Error(`git command failed: ${cmd}`);
    }
  }

  /**
   * Escapa argumento para shell (evita injection).
   */
  private escape(arg: string): string {
    // Envolve em aspas simples e escapa aspas simples internas
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Verifica se git está disponível no sistema.
   */
  private checkGit(): boolean {
    if (this.gitAvailable !== null) return this.gitAvailable;

    try {
      execSync("git --version", { encoding: "utf-8", timeout: 5_000 });
      this.gitAvailable = true;
    } catch {
      this.gitAvailable = false;
      console.warn("[pi-memory] git not found. Wiki versioning disabled.");
    }

    return this.gitAvailable;
  }

  /**
   * Cria .gitignore dentro do wiki para evitar commitar DB/config.
   */
  private writeGitignore(): void {
    const gitignorePath = path.join(this.wikiRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) return;

    const content = [
      "# pi-memory wiki gitignore",
      "# DB e config são índices derivados, não fonte da verdade",
      "*.db",
      "*.db-shm",
      "*.db-wal",
      "config.json",
      "node_modules/",
      "",
    ].join("\n");

    fs.writeFileSync(gitignorePath, content, "utf-8");
  }

  /**
   * Agenda commit batch.
   */
  private scheduleBatch(): void {
    if (this.batchTimer) return;
    this.batchDirty = true;

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flush();
    }, this.config.batchIntervalMs);
  }

  /**
   * Monta mensagem de commit.
   */
  private buildMessage(type: string, detail: string): string {
    const prefix = type === "batch" ? "chore(wiki)" : "feat(wiki)";
    return `${prefix}: ${detail}`;
  }
}
