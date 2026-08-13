/**
 * pi-memory — RetentionScheduler: sweep periódico de retenção por desuso.
 *
 * Independente do PipelineWorker (extração LLM): não há LLM, fila nem retry
 * aqui — só reconcile (espelhar arquivos ativos no banco de atividade),
 * recompute (recalcular retention_score pela fórmula) e apply (gravar os
 * scores no índice FTS para ranking).
 *
 * Garantias:
 * - Nunca altera markdown, nunca move para .supersedes/ e nunca mexe em
 *   confidence — apenas no banco derivado (.retention.sqlite) e na coluna
 *   derivada do índice.
 * - Idempotente: recomputar duas vezes não aplica decay duplicado.
 * - Concorrência entre sessões: WAL + busy_timeout; upsert/recompute são
 *   comutativos.
 * - Sweep em andamento não reentra (flag) — chamadas concorrentes esperam a
 *   atual terminar e retornam o mesmo resultado.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT, RETENTION_SWEEP_INTERVAL_MS, defaultRetentionPolicy, type RetentionPolicy } from "../constants.ts";
import { parseFrontmatter } from "./memory.ts";
import { inferFromRelPath, listActiveMemoryFiles, type MemoryIndex } from "./memory-index.ts";
import { type ActiveDoc, type MemoryActivityStore, type ReconcileStats, type SweepStats } from "./retention-store.ts";
import type { RetentionComputeOpts } from "./retention.ts";

export interface RetentionSweepResult {
	reconcile: ReconcileStats;
	sweep: SweepStats;
	/** Quantos scores foram aplicados no índice (0 se índice indisponível). */
	applied: number;
}

/**
 * Lê os arquivos ativos (global + projeto) como ActiveDoc — a mesma visão
 * do MemoryIndex, com identidade e política do frontmatter. Arquivo sem
 * memory_id ou corrompido é pulado (a migração v3 roda antes no
 * session_start).
 */
export function buildActiveDocs(projectId: string): ActiveDoc[] {
	const docs: ActiveDoc[] = [];
	for (const rel of listActiveMemoryFiles(projectId)) {
		try {
			const raw = readFileSync(join(MEMORIES_ROOT, rel), "utf-8");
			const { meta } = parseFrontmatter(raw);
			const { scope, projectId: pid, type, context } = inferFromRelPath(rel);
			const memoryId = typeof meta.memory_id === "string" ? meta.memory_id : "";
			if (!memoryId) continue;
			const rawPolicy = meta.retention_policy;
			const policy: RetentionPolicy =
				rawPolicy === "protected" || rawPolicy === "normal"
					? rawPolicy
					: defaultRetentionPolicy(type);
			docs.push({ memoryId, path: rel, scope, projectId: pid, type, context, policy });
		} catch {
			// arquivo corrompido — o sweep não pode quebrar por causa dele
		}
	}
	return docs;
}

export class RetentionScheduler {
	private store: MemoryActivityStore;
	private index: MemoryIndex | null;
	private intervalMs: number;

	private projectId: string | null = null;
	private running = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: Promise<RetentionSweepResult> | null = null;

	constructor(
		store: MemoryActivityStore,
		index: MemoryIndex | null,
		opts: { intervalMs?: number } = {},
	) {
		this.store = store;
		this.index = index;
		this.intervalMs = opts.intervalMs ?? RETENTION_SWEEP_INTERVAL_MS;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Troca de projeto — próximo sweep usa o novo (global + projeto novo). */
	setProject(projectId: string | null): void {
		this.projectId = projectId;
	}

	/** Inicia o ciclo periódico (idempotente). */
	start(projectId: string | null): void {
		if (this.running) return;
		this.running = true;
		this.projectId = projectId;
		this.scheduleNext();
	}

	/** Para o ciclo e cancela o timer pendente. */
	stop(): void {
		this.running = false;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Executa um sweep completo agora: reconcile → recompute → apply no
	 * índice. Chamadas concorrentes reutilizam o sweep em andamento (sem
	 * duplicar escrita). Lança se o store não estiver aberto/sem projeto.
	 */
	sweep(
		now: Date = new Date(),
		opts: RetentionComputeOpts = {},
	): Promise<RetentionSweepResult> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.doSweep(now, opts).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async doSweep(
		now: Date,
		opts: RetentionComputeOpts,
	): Promise<RetentionSweepResult> {
		if (!this.projectId) {
			throw new Error("RetentionScheduler: sem projeto ativo — chame start()/setProject().");
		}
		if (!this.store.isOpen) {
			throw new Error("RetentionScheduler: store não aberto.");
		}
		const projectId = this.projectId;
		const docs = buildActiveDocs(projectId);
		const reconcile = this.store.reconcile(docs, projectId, now);
		const sweep = this.store.recompute(projectId, now, opts);
		let applied = 0;
		if (this.index?.isOpen) {
			const scores = this.store.listScoresByPath(projectId);
			this.index.updateRetentionScores(scores);
			applied = scores.size;
		}
		return { reconcile, sweep, applied };
	}

	private scheduleNext(): void {
		if (!this.running || !this.projectId) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.runScheduled();
		}, this.intervalMs);
	}

	private async runScheduled(): Promise<void> {
		if (!this.running || !this.projectId) return;
		try {
			await this.sweep();
		} catch (err) {
			console.warn(`[pi-memory] retention: sweep periódico falhou: ${(err as Error).message}`);
		}
		this.scheduleNext();
	}
}
