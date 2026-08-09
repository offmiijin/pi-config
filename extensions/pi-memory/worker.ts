/**
 * pi-memory — Worker assíncrono de extração (sem dependência do PI).
 *
 * Fase 2: fila de jobs, seleção de episódios, consumer loop com retry/backoff
 * e sinalização por wake (sem polling). A extração em si (chamada LLM) chega
 * na Fase 3 — o executor padrão aqui só seleciona e reclama episódios
 * (normalized → selected) registrando auditoria no job.
 *
 * Modelo:
 *   agent_settled → maybeCreateJob (gatilhos) → worker.wake()
 *   worker loop   → nextEligibleJob → selectEpisodesForJob → processor
 *                 → ok: completeJobWithSelection | retryável: scheduleRetry
 *                   | permanente: dead_letter
 *
 * Garantias:
 * - 1 worker, 1 job por vez (processa o projeto atual — jobs de outros
 *   projetos esperam o usuário estar neles).
 * - Falha de processamento: retry imediato → 30s → 2min → dead_letter.
 * - Crash deixa job em 'processing' → recoverStuckJobs no próximo start.
 */

import {
	EPISODE_STATUS,
	JOB_STATUS,
	type EpisodeRecord,
	type JobRecord,
	type PipelineDB,
} from "./pipeline.ts";

/* ------------------------------------------------------------------ */
/* Constantes e tipos                                                  */
/* ------------------------------------------------------------------ */

/** Orçamento de seleção por job: alvo ~12K, cap rígido 18K (mapping 2.3). */
export const DEFAULT_SELECTION_TOKEN_BUDGET = 12_000;
export const SELECTION_HARD_CAP = 18_000;

/** Gatilhos de criação de job (mapping 2.2). */
export const DEFAULT_ELIGIBLE_TOKENS = 10_000;
export const DEFAULT_ELIGIBLE_EPISODES = 5;

/** Retry: 1º imediato, 2º 30s, 3º 2min; após MAX_ATTEMPTS → dead_letter. */
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_BACKOFF_MS = [0, 30_000, 120_000];

/** Episódios selecionados para um job. */
export interface SelectedEpisodes {
	episodeIds: string[];
	episodes: EpisodeRecord[];
	totalTokens: number;
}

/** Resultado da execução de um job pelo processor. */
export interface JobExecutionResult {
	ok: boolean;
	/** true = falha transitória (retry com backoff); false/omitto = permanente. */
	retryable?: boolean;
	error?: string;
	details?: Record<string, unknown>;
	/**
	 * Status terminal dos episódios no sucesso: 'selected' (seleção, Fase 2)
	 * ou 'processed' (extração, Fase 3). Default: 'selected'.
	 */
	episodesStatus?: EpisodeStatus;
}

export type JobProcessor = (
	pipeline: PipelineDB,
	job: JobRecord,
	selection: SelectedEpisodes,
	signal?: AbortSignal,
) => Promise<JobExecutionResult>;

export interface WorkerOptions {
	processor?: JobProcessor;
	maxAttempts?: number;
	backoffMs?: number[];
	/**
	 * Inclui episódios 'selected' (claimados por job anterior) na seleção —
	 * usado pela extração (Fase 3) para processar o que a seleção (Fase 2)
	 * deixou em espera. Default: false.
	 */
	includeClaimed?: boolean;
}

/* ------------------------------------------------------------------ */
/* Seleção e gatilhos                                                  */
/* ------------------------------------------------------------------ */

/**
 * Seleciona episódios normalized do projeto para um job: mais antigos
 * primeiro, acumulando até o alvo sem estourar o hard cap. Um episódio único
 * maior que o cap é incluído mesmo assim (episódio é a unidade — a
 * orçamentação de evidências acontece na montagem do prompt, Fase 3).
 */
export function selectEpisodesForJob(
	pipeline: PipelineDB,
	projectId: string,
	opts: { targetTokens?: number; hardCap?: number; includeClaimed?: boolean } = {},
): SelectedEpisodes {
	const target = opts.targetTokens ?? DEFAULT_SELECTION_TOKEN_BUDGET;
	const hardCap = opts.hardCap ?? SELECTION_HARD_CAP;
	const statuses = opts.includeClaimed
		? [EPISODE_STATUS.NORMALIZED, EPISODE_STATUS.SELECTED]
		: [EPISODE_STATUS.NORMALIZED];

	const episodes = pipeline.listEpisodesByStatuses(projectId, statuses);
	const picked: EpisodeRecord[] = [];
	let total = 0;

	for (const ep of episodes) {
		if (total + ep.tokenEstimate > hardCap && picked.length > 0) break;
		picked.push(ep);
		total += ep.tokenEstimate;
		if (total >= target) break;
	}

	return {
		episodeIds: picked.map((e) => e.id),
		episodes: picked,
		totalTokens: total,
	};
}

/** Resultado da avaliação de gatilho. */
export interface JobTriggerStats {
	jobId: string | null;
	reason: string | null;
	eligibleTokens: number;
	eligibleEpisodes: number;
}

export interface CreateJobOpts {
	/** true = cria job mesmo com outro ativo (ex.: memory_extract manual). */
	force?: boolean;
	maxEligibleTokens?: number;
	maxEligibleEpisodes?: number;
	/** Episódio recém-settled — gatilho por sinal forte (correção/erro). */
	signalEpisodeId?: string;
}

/**
 * Avalia os gatilhos de criação de job (mapping 2.2) e cria na fila quando
 * algum dispara. Não acumula: se já existe job não terminal para o projeto,
 * só `force` cria outro (o job ativo absorverá os episódios novos).
 */
export function maybeCreateJob(
	pipeline: PipelineDB,
	projectId: string,
	opts: CreateJobOpts = {},
): JobTriggerStats {
	const force = opts.force ?? false;
	const maxTokens = opts.maxEligibleTokens ?? DEFAULT_ELIGIBLE_TOKENS;
	const maxEpisodes = opts.maxEligibleEpisodes ?? DEFAULT_ELIGIBLE_EPISODES;

	// Só trabalho NOVO (normalized) conta para o gatilho automático —
	// episódios 'selected' (reivindicados por job com pendings) não podem
	// re-disparar jobs em loop; são re-selecionados via includeClaimed quando
	// um novo job abre (ou via memory_extract manual).
	const { tokens, count } = pipeline.aggregateNormalizedEpisodes(projectId);

	let reason: string | null = null;
	if (force) {
		reason = "manual";
	} else if (pipeline.hasActiveJob(projectId)) {
		// Job ativo absorve os episódios novos — não empilha.
		return { jobId: null, reason: null, eligibleTokens: tokens, eligibleEpisodes: count };
	} else if (tokens >= maxTokens) {
		reason = "tokens";
	} else if (count >= maxEpisodes) {
		reason = "episodes";
	} else if (opts.signalEpisodeId && pipeline.hasStrongSignal(opts.signalEpisodeId)) {
		reason = "signal";
	}

	if (!reason) return { jobId: null, reason: null, eligibleTokens: tokens, eligibleEpisodes: count };
	const jobId = pipeline.createJob(projectId, reason);
	return { jobId, reason, eligibleTokens: tokens, eligibleEpisodes: count };
}

/**
 * Executor padrão da Fase 2 (substituído pela extração real na Fase 3):
 * aceita a seleção e devolve sucesso — o worker então reclama os episódios
 * (normalized → selected) e completa o job com auditoria da seleção.
 */
export async function selectionOnlyProcessor(
	_pipeline: PipelineDB,
	_job: JobRecord,
	selection: SelectedEpisodes,
): Promise<JobExecutionResult> {
	return {
		ok: true,
		episodesStatus: EPISODE_STATUS.SELECTED,
		details: {
			phase: "selection",
			episodes: selection.episodeIds.length,
			tokens: selection.totalTokens,
		},
	};
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

export class PipelineWorker {
	private pipeline: PipelineDB;
	private processor: JobProcessor;
	private maxAttempts: number;
	private backoffMs: number[];

	private running = false;
	private loopPromise: Promise<void> | null = null;
	private activeJobId: string | null = null;
	/** Projeto ativo (definido pelo index.ts — o worker só processa o atual). */
	private projectId: string | null = null;
	/** Controller do job em processamento — abortado no stop() para não bloquear shutdown. */
	private abortController: AbortController | null = null;

	// Sinal de wake: promise resolvida por wake(); flag evita wake perdido
	// entre o fim do drain e o início da espera.
	private wakeResolve: (() => void) | null = null;
	private wakePending = false;
	private includeClaimed: boolean;

	constructor(pipeline: PipelineDB, opts: WorkerOptions = {}) {
		this.pipeline = pipeline;
		this.processor = opts.processor ?? selectionOnlyProcessor;
		this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.includeClaimed = opts.includeClaimed ?? false;
	}

	get isRunning(): boolean {
		return this.running;
	}

	get currentJobId(): string | null {
		return this.activeJobId;
	}

	/** Define o projeto ativo (chamado em session_start/session_tree). */
	setProject(projectId: string | null): void {
		this.projectId = projectId;
		this.wake();
	}

	/** Inicia o loop de consumo (idempotente). */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopPromise = this.runLoop();
	}

	/** Para o loop graciosamente; job em processamento é ABORTADO (signal no
	 *  model.complete) — stop() não espera uma chamada LLM terminar. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.abortController?.abort();
		this.wake(); // libera a espera (clearTimeout incluso)
		if (this.loopPromise) {
			await this.loopPromise;
			this.loopPromise = null;
		}
	}

	/** Acorda o worker (fila pode ter trabalho). Seguro chamar sempre. */
	wake(): void {
		if (this.wakeResolve) {
			const resolve = this.wakeResolve;
			this.wakeResolve = null;
			resolve();
		} else {
			this.wakePending = true;
		}
	}

	private async runLoop(): Promise<void> {
		while (this.running) {
			const job = this.nextEligibleJob();
			if (!job) {
				await this.waitForWake();
				continue;
			}
			this.activeJobId = job.id;
			try {
				await this.processJob(job);
			} catch (err) {
				// Falha inesperada (DB etc.) — loga e segue; o job preso em
				// processing é recuperado por recoverStuckJobs no próximo start.
				console.warn(`[pi-memory] worker: erro inesperado no job ${job.id}: ${(err as Error).message}`);
			} finally {
				this.activeJobId = null;
				// Reavalia os gatilhos após cada job: episódios que ficaram em
				// espera (ex.: selected por pendings de validação, ou capturados
				// DURANTE o job — fora da seleção) podem abrir um novo job. O
				// próximo nextEligibleJob() o encontra sem esperar wake.
				if (this.projectId) {
					maybeCreateJob(this.pipeline, this.projectId);
				}
			}
		}
	}

	private nextEligibleJob(): JobRecord | undefined {
		if (!this.projectId) return undefined;
		return this.pipeline.nextEligibleJob(this.projectId);
	}

	/** Espera wake (ou o retry mais próximo vencer). Sem polling ativo. */
	private async waitForWake(): Promise<void> {
		if (this.wakePending) {
			this.wakePending = false;
			return;
		}
		const delay = this.projectId ? this.pipeline.nextRetryDelayMs(this.projectId) : null;
		await new Promise<void>((resolve) => {
			const timer =
				delay !== null && delay > 0
					? setTimeout(() => {
							this.wakeResolve = null;
							resolve();
						}, delay)
					: null;
			this.wakeResolve = () => {
				if (timer) clearTimeout(timer);
				resolve();
			};
		});
		this.wakeResolve = null;
	}

	private async processJob(job: JobRecord): Promise<void> {
		this.pipeline.updateJob(job.id, {
			status: JOB_STATUS.PROCESSING,
			startedAt: new Date().toISOString(),
		});

		const selection = selectEpisodesForJob(this.pipeline, job.projectId, {
			includeClaimed: this.includeClaimed,
		});

		// Controller por job: stop() aborta a chamada LLM em andamento.
		const controller = new AbortController();
		this.abortController = controller;

		let result: JobExecutionResult;
		try {
			result = await this.processor(this.pipeline, job, selection, controller.signal);
		} catch (err) {
			result = { ok: false, retryable: true, error: (err as Error).message ?? String(err) };
		} finally {
			this.abortController = null;
		}

		if (result.ok) {
			const episodeStatus = result.episodesStatus ?? EPISODE_STATUS.SELECTED;
			this.pipeline.completeJobWithEpisodes(
				job.id,
				selection.episodeIds,
				episodeStatus,
				result.details ?? null,
			);
			return;
		}

		if (result.retryable && job.attempts < this.maxAttempts) {
			const attempts = job.attempts + 1;
			const delayMs = this.backoffMs[Math.min(attempts - 1, this.backoffMs.length - 1)] ?? 0;
			this.pipeline.scheduleRetry(job.id, { attempts, error: result.error, delayMs });
			return;
		}

		this.pipeline.markDeadLetter(job.id, result.error);
	}
}
