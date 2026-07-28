/**
 * ObservationBuffer — Buffer de observações cruas em memória.
 *
 * Acumula RawObservations e faz flush para storage em lote.
 * Fire-and-forget: enfileiramento não bloqueia o agente.
 */

import type { RawObservation } from "../types";
import type { IStorage } from "../storage/index";

export class ObservationBuffer {
  private buffer: RawObservation[] = [];
  private storage: IStorage | null = null;
  private maxSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;

  constructor(maxSize = 100, flushIntervalMs = 30_000) {
    this.maxSize = maxSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  /** Vincula storage e inicia auto-flush periódico */
  attach(storage: IStorage): void {
    this.storage = storage;
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
      // Não bloqueia o event loop — permite que o processo saia
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
  }

  /** Desvincula storage e para auto-flush */
  detach(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.storage = null;
  }

  /** Adiciona observação ao buffer. Se buffer cheio, dispara flush síncrono. */
  enqueue(obs: RawObservation): void {
    this.buffer.push(obs);

    if (this.buffer.length >= this.maxSize) {
      this.flush();
    }
  }

  /** Adiciona múltiplas observações de uma vez */
  enqueueBatch(observations: RawObservation[]): void {
    this.buffer.push(...observations);

    if (this.buffer.length >= this.maxSize) {
      this.flush();
    }
  }

  /** Escreve todo o buffer pendente para storage e limpa */
  flush(): void {
    if (this.buffer.length === 0) return;
    if (!this.storage) return;

    const batch = this.buffer.splice(0);
    try {
      this.storage.insertObservationsBatch(batch);
    } catch {
      // Fire-and-forget: falha no storage não deve quebrar o agente.
      // Observações perdidas são aceitáveis (melhor que crash).
    }
  }

  /** Número de observações pendentes no buffer */
  size(): number {
    return this.buffer.length;
  }

  /** Esvazia o buffer sem persistir (para descarte) */
  clear(): void {
    this.buffer = [];
  }
}
