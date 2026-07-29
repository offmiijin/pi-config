/**
 * PageSweepConsolidator — N2: Background sweep periódico sobre páginas.
 *
 * Roda a cada intervalo configurável (default: 30 min).
 * Fluxo:
 *   1. Agrupa observações pendentes por tool_name → dispara LLM extract
 *   2. Aplica decay de confidence em páginas não atualizadas há decayDays
 *   3. Aplica pruning: marca como superseded páginas com confidence baixa
 *      e sem atualização há pruningAgeDays
 *   4. Limpa observações com TTL expirado
 *
 * Páginas "pinned" e já "superseded" são imunes a decay/pruning.
 */

import type { Page } from "../types";
import type { IStorage } from "../storage/index";
import type { PageStore } from "../storage/page-store";
import type { LlmExtractor } from "../extract/llm-extractor";

// ── Config ─────────────────────────────────────────────────────────────

export interface SweepConfig {
  /** Intervalo do sweep em ms. Default: 30 min */
  intervalMs: number;
  /** Decay habilitado? */
  decayEnabled: boolean;
  /** Dias sem atualização (updated_at) para iniciar decay. Default: 7 */
  decayDays: number;
  /** Fator de multiplicação da confidence no decay. Default: 0.9 */
  decayFactor: number;
  /** Pruning habilitado? */
  pruningEnabled: boolean;
  /** Confidence abaixo da qual página é candidata a pruning. Default: 0.1 */
  pruningConfidenceThreshold: number;
  /** Dias sem atualização (updated_at) para pruning. Default: 30 */
  pruningAgeDays: number;
}

const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  intervalMs: 30 * 60 * 1000,
  decayEnabled: false,
  decayDays: 7,
  decayFactor: 0.9,
  pruningEnabled: false,
  pruningConfidenceThreshold: 0.1,
  pruningAgeDays: 30,
};

// ── PageSweepConsolidator ──────────────────────────────────────────────

export class PageSweepConsolidator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly config: SweepConfig;
  private readonly storage: IStorage;
  private readonly pageStore: PageStore | null;
  private readonly llmExtractor: LlmExtractor;
  private readonly projectId: string;
  private readonly onSweep?: () => void;

  constructor(
    storage: IStorage,
    llmExtractor: LlmExtractor,
    projectId: string,
    overrides: Partial<SweepConfig> = {},
    onSweep?: () => void,
    pageStore?: PageStore,
  ) {
    this.storage = storage;
    this.llmExtractor = llmExtractor;
    this.projectId = projectId;
    this.config = { ...DEFAULT_SWEEP_CONFIG, ...overrides };
    this.onSweep = onSweep;
    this.pageStore = pageStore ?? null;
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Inicia scheduler periódico */
  schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.run(), this.config.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Para scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executa um ciclo completo de sweep.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      // 1. Extração LLM de observações pendentes — envia todas de uma vez
      const pending = this.storage.getPendingObservations(this.projectId);
      if (pending.length > 0) {
        this.llmExtractor.extractBatch(pending);
      }

      // 2. Decay de confidence
      if (this.config.decayEnabled) {
        this.applyDecay();
      }

      // 3. Pruning de páginas obsoletas
      if (this.config.pruningEnabled) {
        this.applyPruning();
      }

      // 4. Limpeza de observações expiradas (TTL)
      this.storage.cleanupExpired(Date.now());

      this.onSweep?.();
    } catch {
      // Sweep nunca quebra o agente
    } finally {
      this.running = false;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  /** Reduz confidence de páginas não atualizadas há decayDays. */
  private applyDecay(): void {
    const pages = this.storage.getPagesByProject(this.projectId);
    const now = Date.now();
    const decayThreshold = now - this.config.decayDays * 24 * 60 * 60 * 1000;

    for (const page of pages) {
      if (page.pinned) continue;
      if (page.status === "superseded") continue;

      if (page.updated_at < decayThreshold) {
        const newConfidence = Math.max(0, page.confidence * this.config.decayFactor);

        // Prefere PageStore (atualiza .md + SQLite) para evitar divergência wiki↔índice.
        // Fallback para storage direto se PageStore não disponível.
        if (this.pageStore) {
          try {
            this.pageStore.updatePageMetadata(page.project_id, page.path, {
              confidence: newConfidence,
            });
          } catch {
            // Fallback: atualiza só SQLite
            const updated: Page = { ...page, confidence: newConfidence };
            this.storage.updatePage(updated);
          }
        } else {
          const updated: Page = { ...page, confidence: newConfidence };
          this.storage.updatePage(updated);
        }
      }
    }
  }

  /** Marca como superseded páginas com confidence baixa e sem atualização. */
  private applyPruning(): void {
    const pages = this.storage.getPagesByProject(this.projectId);
    const now = Date.now();
    const ageThreshold = now - this.config.pruningAgeDays * 24 * 60 * 60 * 1000;

    for (const page of pages) {
      if (page.pinned) continue;
      if (page.status === "superseded") continue;

      if (
        page.confidence < this.config.pruningConfidenceThreshold &&
        page.updated_at < ageThreshold
      ) {
        // Prefere PageStore (atualiza .md + SQLite) para evitar divergência wiki↔índice.
        // Fallback para storage direto se PageStore não disponível.
        if (this.pageStore) {
          try {
            this.pageStore.updatePageMetadata(page.project_id, page.path, {
              status: "superseded",
            });
          } catch {
            const updated: Page = { ...page, status: "superseded" };
            this.storage.updatePage(updated);
          }
        } else {
          const updated: Page = { ...page, status: "superseded" };
          this.storage.updatePage(updated);
        }
      }
    }
  }
}
