/**
 * pi-memory — Algoritmo de retenção (funções puras, sem dependência do PI).
 *
 * O retention_score mede RELEVÂNCIA OPERACIONAL por desuso — não certeza
 * factual (isso é `confidence`, que só o memory_decay manual mexe). A
 * fórmula é determinística sobre timestamps: recalcular duas vezes nunca
 * aplica decay duplicado (sweep idempotente).
 */

import {
	RETENTION_GRACE_DAYS,
	RETENTION_HALF_LIFE_DAYS,
	RETENTION_MIN_SCORE,
} from "../constants.ts";

/** Milissegundos por dia (base do cálculo). */
export const DAY_MS = 86_400_000;

export interface RetentionComputeOpts {
	/** Sem decay antes deste período sem uso (dias). Default 30. */
	graceDays?: number;
	/** Meia-vida do score: cai pela metade a cada N dias de desuso. Default 90. */
	halfLifeDays?: number;
	/** Piso do score. Default 0.05. */
	minScore?: number;
}

/**
 * Dias sem uso efetivos: usa last_used_at quando a memória já foi usada;
 * senão (nunca usada) usa first_seen_at (criação) como referência. Nunca
 * negativo — relógio regressivo não aumenta o score.
 */
export function idleDays(
	now: Date,
	lastUsedAt: string | null,
	firstSeenAt: string,
): number {
	const ref = lastUsedAt ? new Date(lastUsedAt) : new Date(firstSeenAt);
	const ms = now.getTime() - ref.getTime();
	return Math.max(0, ms / DAY_MS);
}

/**
 * Score de retenção por fórmula de meia-vida com grace period:
 *
 *   decayDays = max(0, idleDays - graceDays)
 *   score     = 2 ** (-decayDays / halfLifeDays)
 *   score     = max(score, minScore)
 *
 * Exemplos (sem uso): 30d → 1.00 · 75d → ~0.71 · 120d → ~0.50 · 210d → ~0.25.
 */
export function computeRetentionScore(
	idleDaysValue: number,
	opts: RetentionComputeOpts = {},
): number {
	const grace = opts.graceDays ?? RETENTION_GRACE_DAYS;
	const halfLife = opts.halfLifeDays ?? RETENTION_HALF_LIFE_DAYS;
	const minScore = opts.minScore ?? RETENTION_MIN_SCORE;
	const decayDays = Math.max(0, idleDaysValue - grace);
	const score = Math.pow(2, -decayDays / halfLife);
	return Math.max(minScore, Math.round(score * 1000) / 1000);
}
