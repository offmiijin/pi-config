/**
 * pi-memory — Worker assíncrono de extração (sem dependência do PI).
 *
 * Fila de jobs, seleção de episódios, consumer loop com retry/backoff
 * e sinalização por wake (sem polling). A extração em si (chamada LLM) é
 * executada pelo processor; o worker seleciona e reclama episódios
 * (normalized → selected) registrando auditoria no job.
 *
 * Modelo (consolidação por sessão, sempre via LLM):
 *   agent_settled      → captura leve (episódio + evidências, SEM job)
 *   session_compact    → chunk jobs `compact` do trecho resumido (imediato)
 *   session_shutdown   → marca pending_sessions (síncrono, sem LLM)
 *   session_start      → reivindica pendings → chunk jobs `session`
 *   worker loop → nextEligibleJob → episódios pré-vinculados → processor
 *               → ok: completeJobWithEpisodes | retryável: scheduleRetry
 *                 | permanente: dead_letter
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
	type EpisodeStatus,
	type JobRecord,
	type PipelineDB,
} from "./pipeline.ts";

/* ------------------------------------------------------------------ */
/* Constantes e tipos                                                  */
/* ------------------------------------------------------------------ */

/** Orçamento de chunk por job: alvo ~12K, cap rígido 18K tokens. */
export const DEFAULT_SELECTION_TOKEN_BUDGET = 12_000;
export const SELECTION_HARD_CAP = 18_000;

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
	 * Status terminal dos episódios no sucesso: 'selected' (seleção)
	 * ou 'processed' (extração). Default: 'selected'.
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
	 * usado pela extração para processar o que a seleção
	 * deixou em espera. Default: false.
	 */
	includeClaimed?: boolean;
}

/* ------------------------------------------------------------------ */
/* Seleção e chunks de sessão                                                  */
/* ------------------------------------------------------------------ */

/**
 * Divide episódios ordenados (mais antigos primeiro) em chunks de
 * consolidação: acumula até o alvo sem estourar o hard cap. Um episódio
 * único maior que o cap forma um chunk sozinho (episódio é a unidade — a
 * orçamentação fina de evidências acontece na montagem do prompt).
 * Sessões grandes viram N chunks sequenciais; cada chunk é um job.
 */
export function chunkEpisodes(
	episodes: EpisodeRecord[],
	opts: { targetTokens?: number; hardCap?: number } = {},
): EpisodeRecord[][] {
	const target = opts.targetTokens ?? DEFAULT_SELECTION_TOKEN_BUDGET;
	const hardCap = opts.hardCap ?? SELECTION_HARD_CAP;
	const chunks: EpisodeRecord[][] = [];
	let current: EpisodeRecord[] = [];
	let total = 0;
	for (const ep of episodes) {
		if (current.length > 0 && total + ep.tokenEstimate > hardCap) {
			chunks.push(current);
			current = [];
			total = 0;
		}
		current.push(ep);
		total += ep.tokenEstimate;
		if (total >= target) {
			chunks.push(current);
			current = [];
			total = 0;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * Seleciona episódios normalized do projeto para um job legado (sem vínculo
 * prévio): mais antigos primeiro até o alvo/hard cap. Jobs de sessão
 * (`session`/`compact`/`manual`) já nascem pré-vinculados via
 * createJobWithEpisodes — o worker prefere o vínculo e só usa esta seleção
 * como fallback.
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

/**
 * Cria chunk jobs de consolidação para UMA sessão: lista os episódios
 * normalized da sessão (mais antigos primeiro), divide em chunks e cria um
 * job pré-vinculado por chunk (reason `session`/`compact`/`manual`).
 * Episódios selected (claims de retry) não entram — são reprocessados via
 * includeClaimed no fallback de seleção. Retorna os ids criados.
 *
 * Dedup entre chunks: os jobs rodam em sequência e cada commit sincroniza o
 * índice FTS — o chunk N+1 enxerga as memórias do chunk N via
 * getRelatedMemories e prefere update/supersede a duplicar.
 */
export function createSessionJobs(
	pipeline: PipelineDB,
	projectId: string,
	sessionId: string,
	reason: string,
	opts: { targetTokens?: number; hardCap?: number } = {},
): string[] {
	const episodes = pipeline.listEpisodesBySession(sessionId, [EPISODE_STATUS.NORMALIZED]);
	const owned = episodes.filter((e) => e.projectId === projectId);
	if (owned.length === 0) return [];
	const chunks = chunkEpisodes(owned, opts);
	return chunks.map((chunk, i) =>
		pipeline.createJobWithEpisodes(projectId, reason, chunk.map((e) => e.id), {
			sessionId,
			chunk: i + 1,
			chunks: chunks.length,
		}),
	);
}

/**
 * Executor padrão (substituído pela extração real):
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
		// Troca de projeto ABORTA o job em processamento: a extração em voo
		// era do projeto anterior — continuar gastaria tokens num contexto que
		// o usuário deixou. O abort vira retry do job (próximo acesso ao
		// projeto o retoma via nextEligibleJob, que filtra por projectId).
		if (projectId !== this.projectId) {
			this.abortController?.abort();
		}
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
				// Sem gatilhos automáticos: novos jobs nascem em
				// session_compact / session_start (pendings) / memory_extract.
				// Chunk jobs da mesma sessão já estão enfileirados — o próximo
				// nextEligibleJob() os encontra sem esperar wake.
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

		// Jobs de sessão (session/compact/manual) nascem pré-vinculados aos
		// episódios do chunk — processa o vínculo. Fallback legado: seleção
		// adiada (jobs criados sem vínculo, ex.: versões anteriores).
		const linked = this.pipeline.listEpisodesByJob(job.id);
		const selection =
			linked.length > 0
				? {
						episodeIds: linked.map((e) => e.id),
						episodes: linked,
						totalTokens: linked.reduce((s, e) => s + e.tokenEstimate, 0),
					}
				: selectEpisodesForJob(this.pipeline, job.projectId, {
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
