/**
 * SweepConsolidator — N2: Background sweep periódico.
 *
 * Roda a cada intervalo configurável (default: 30 min) ou ao atingir
 * threshold de observações pendentes. Executa extração LLM em grupos
 * de observações por tool_name, aplica decay de confidence, pruning
 * de memórias obsoletas e limpeza de TTL.
 *
 * ADR-004: Nível 2 — Background sweep (custo baixo, fire-and-forget).
 */

import type { RawObservation, Memory } from "../types";
import type { IStorage } from "../storage/index";
import type { LlmExtractor } from "../extract/llm-extractor";

// ── Config ─────────────────────────────────────────────────────────────

export interface SweepConfig {
  /** Intervalo do sweep em ms. Default: 30 min */
  intervalMs: number;
  /** Dispara sweep a cada N observações pendentes. Default: 50 */
  observationThreshold: number;
  /** Tamanho mínimo do grupo para extrair. Default: 3 */
  minGroupSize: number;
  /** Decay habilitado? */
  decayEnabled: boolean;
  /** Dias sem acesso para iniciar decay. Default: 7 */
  decayDays: number;
  /** Fator de multiplicação da confidence no decay. Default: 0.9 */
  decayFactor: number;
  /** Pruning habilitado? */
  pruningEnabled: boolean;
  /** Confidence abaixo da qual memória é candidata a pruning. Default: 0.1 */
  pruningConfidenceThreshold: number;
  /** Dias sem acesso para pruning. Default: 30 */
  pruningAgeDays: number;
}

const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  intervalMs: 30 * 60 * 1000,
  observationThreshold: 50,
  minGroupSize: 3,
  decayEnabled: false,
  decayDays: 7,
  decayFactor: 0.9,
  pruningEnabled: false,
  pruningConfidenceThreshold: 0.1,
  pruningAgeDays: 30,
};

// ── SweepConsolidator ──────────────────────────────────────────────────

export class SweepConsolidator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly config: SweepConfig;
  private readonly storage: IStorage;
  private readonly llmExtractor: LlmExtractor;
  private readonly projectId: string;
  private readonly onSweep?: () => void;

  constructor(
    storage: IStorage,
    llmExtractor: LlmExtractor,
    projectId: string,
    overrides: Partial<SweepConfig> = {},
    onSweep?: () => void,
  ) {
    this.storage = storage;
    this.llmExtractor = llmExtractor;
    this.projectId = projectId;
    this.config = { ...DEFAULT_SWEEP_CONFIG, ...overrides };
    this.onSweep = onSweep;
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
   *
   * Fluxo:
   *  1. Agrupa observações pendentes por tool_name
   *  2. Para cada grupo com ≥minGroupSize, extrai fatos via LLM
   *  3. Aplica decay de confidence em memórias antigas
   *  4. Remove memórias com confidence muito baixa (pruning)
   *  5. Remove observações com TTL expirado
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      // 1. Busca observações pendentes
      const pending = this.storage.getPendingObservations(this.projectId);
      if (pending.length > 0) {
        // 2. Agrupa por tool_name
        const groups = this.groupByToolName(pending);

        // 3. Para cada grupo ≥ minGroupSize, dispara extração
        for (const [, observations] of groups) {
          if (observations.length >= this.config.minGroupSize) {
            this.llmExtractor.extractBatch(observations);
          }
        }
      }

      // 4. Decay de confidence
      if (this.config.decayEnabled) {
        this.applyDecay();
      }

      // 5. Pruning de memórias obsoletas
      if (this.config.pruningEnabled) {
        this.applyPruning();
      }

      // 6. Limpeza de TTL
      const expired = this.storage.cleanupExpired(Date.now());
      if (expired > 0) {
        // Audit log implícito via onSweep
      }

      this.onSweep?.();
    } catch {
      // Sweep nunca quebra o agente
    } finally {
      this.running = false;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private groupByToolName(
    observations: RawObservation[],
  ): Map<string, RawObservation[]> {
    const groups = new Map<string, RawObservation[]>();
    for (const obs of observations) {
      const key = obs.tool_name ?? "unknown";
      const group = groups.get(key);
      if (group) {
        group.push(obs);
      } else {
        groups.set(key, [obs]);
      }
    }
    return groups;
  }

  private applyDecay(): void {
    const memories = this.storage.getMemoriesByProject(this.projectId);
    const now = Date.now();
    const decayThreshold = now - this.config.decayDays * 24 * 60 * 60 * 1000;

    for (const mem of memories) {
      if (mem.pinned) continue;
      if (mem.superseded_by) continue;

      const lastAccess = mem.last_accessed ?? mem.timestamp;
      if (lastAccess < decayThreshold) {
        const newConfidence = Math.max(0, mem.confidence * this.config.decayFactor);
        const updated: Memory = {
          ...mem,
          confidence: newConfidence,
        };
        this.storage.updateMemory(updated);
      }
    }
  }

  private applyPruning(): void {
    const memories = this.storage.getMemoriesByProject(this.projectId);
    const now = Date.now();
    const ageThreshold = now - this.config.pruningAgeDays * 24 * 60 * 60 * 1000;

    for (const mem of memories) {
      if (mem.pinned) continue;
      if (mem.superseded_by) continue;

      const lastAccess = mem.last_accessed ?? mem.timestamp;
      if (
        mem.confidence < this.config.pruningConfidenceThreshold &&
        lastAccess < ageThreshold
      ) {
        this.storage.deleteMemory(mem.id);
      }
    }
  }
}
