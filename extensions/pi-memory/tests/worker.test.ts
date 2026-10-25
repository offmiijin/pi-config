/**
 * pi-memory — Tests: worker assíncrono e fila de jobs.
 *
 * Usa banco temporário (mkdtemp). Testa: CRUD de jobs, fila (queued/retry),
 * seleção de episódios, gatilhos de criação, consumer loop (sucesso, retry,
 * dead_letter), escopo por projeto e recuperação de jobs presos.
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
	EPISODE_STATUS,
	JOB_STATUS,
	PipelineDB,
	type NewEpisode,
} from "../pipeline/pipeline.ts";
import {
	JOB_REASONS,
	PENDING_SESSION_STATUS,
	type EpisodeRecord,
} from "../pipeline/pipeline.ts";
import {
	PipelineWorker,
	chunkEpisodes,
	createSessionJobs,
	selectEpisodesForJob,
	type JobExecutionResult,
	type JobProcessor,
} from "../pipeline/worker.ts";

let tmpDir: string;
let dbPath: string;
let pipeline: PipelineDB;

function makeEpisode(overrides: Partial<NewEpisode> & { fingerprint?: string } = {}): NewEpisode {
	return {
		projectId: "proj-a",
		sessionId: `sess-${Math.random()}`,
		sessionFile: "/tmp/sess.jsonl",
		startEntryId: "a",
		endEntryId: "b",
		leafId: "b",
		fingerprint: `fp-${Math.random()}`,
		tokenEstimate: 100,
		...overrides,
	};
}

/** Insere episódio e marca normalized (sem evidências). */
function makeNormalizedEpisode(tokenEstimate: number, projectId = "proj-a"): string {
	const id = pipeline.insertEpisode(makeEpisode({ projectId, tokenEstimate }));
	pipeline.finalizeEpisode(id, [], EPISODE_STATUS.NORMALIZED);
	return id;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("timeout esperando condição");
		await new Promise((r) => setTimeout(r, 10));
	}
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-worker-"));
	dbPath = join(tmpDir, ".pipeline.sqlite");
	pipeline = new PipelineDB(dbPath);
	pipeline.open();
});

afterAll(() => {
	pipeline.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("PipelineDB jobs (CRUD + fila)", () => {
	it("createJob → getJob → countJobs", () => {
		const id = pipeline.createJob("proj-a", "tokens");
		const job = pipeline.getJob(id)!;
		expect(job.status).toBe(JOB_STATUS.QUEUED);
		expect(job.attempts).toBe(0);
		expect(job.projectId).toBe("proj-a");
		expect(job.reason).toBe("tokens");
		expect(pipeline.countJobs("proj-a")).toBe(1);
		expect(pipeline.countJobs("proj-a", JOB_STATUS.QUEUED)).toBe(1);
		expect(pipeline.countJobs("proj-a", JOB_STATUS.DONE)).toBe(0);
	});

	it("nextEligibleJob retorna o mais antigo e ignora retry futuro", () => {
		const proj = "proj-q";
		const j1 = pipeline.createJob(proj, "tokens");
		const j2 = pipeline.createJob(proj, "episodes");
		expect(pipeline.nextEligibleJob(proj)!.id).toBe(j1);
		pipeline.updateJob(j1, { status: JOB_STATUS.DONE, finishedAt: new Date().toISOString() });
		expect(pipeline.nextEligibleJob(proj)!.id).toBe(j2);

		// retry com next_attempt_at futuro não é elegível
		pipeline.scheduleRetry(j2, { attempts: 1, error: "x", delayMs: 60_000 });
		expect(pipeline.nextEligibleJob(proj)).toBeUndefined();
		const delay = pipeline.nextRetryDelayMs(proj);
		expect(delay).toBeDefined();
		expect(delay!).toBeGreaterThan(0);
		// retry vencido volta a ser elegível
		pipeline.updateJob(j2, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });
		expect(pipeline.nextEligibleJob(proj)!.id).toBe(j2);
	});

	it("completeJobWithEpisodes finaliza o job (sem jobs não terminais)", () => {
		const proj = "proj-active";
		const jobId = pipeline.createJob(proj, JOB_REASONS.SESSION);
		expect(pipeline.nextEligibleJob(proj)!.id).toBe(jobId);
		const epId = pipeline.insertEpisode(makeEpisode({ projectId: proj }));
		pipeline.finalizeEpisode(epId, [], EPISODE_STATUS.NORMALIZED);
		pipeline.completeJobWithEpisodes(jobId, [epId], EPISODE_STATUS.PROCESSED, null);
		expect(pipeline.nextEligibleJob(proj)).toBeUndefined();
	});

	it("recoverStuckJobs devolve jobs presos para queued", () => {
		const id = pipeline.createJob("proj-recover", "tokens");
		pipeline.updateJob(id, { status: JOB_STATUS.PROCESSING, startedAt: new Date().toISOString() });
		const recovered = pipeline.recoverStuckJobs();
		expect(recovered).toBeGreaterThanOrEqual(1);
		expect(pipeline.getJob(id)!.status).toBe(JOB_STATUS.QUEUED);
		pipeline.updateJob(id, { status: JOB_STATUS.DONE, finishedAt: new Date().toISOString() });
	});

	it("completeJobWithSelection vincula episódios e marca selected", () => {
		const ep1 = makeNormalizedEpisode(200);
		const ep2 = makeNormalizedEpisode(300);
		const jobId = pipeline.createJob("proj-a", "tokens");
		pipeline.completeJobWithSelection(jobId, [ep1, ep2], { phase: "selection", episodes: 2 });

		expect(pipeline.getJob(jobId)!.status).toBe(JOB_STATUS.DONE);
		expect(pipeline.getJob(jobId)!.details).toContain("selection");
		expect(pipeline.getEpisode(ep1)!.status).toBe(EPISODE_STATUS.SELECTED);
		expect(pipeline.getEpisode(ep2)!.status).toBe(EPISODE_STATUS.SELECTED);
	});
});

describe("selectEpisodesForJob", () => {
	it("pega normalized mais antigos até o orçamento", () => {
		const proj = "proj-s-budget";
		makeNormalizedEpisode(1000, proj); // mais antigo
		makeNormalizedEpisode(5000, proj);
		makeNormalizedEpisode(9000, proj);
		const sel = selectEpisodesForJob(pipeline, proj, { targetTokens: 7000, hardCap: 18_000 });
		// Inclui o episódio que cruza o alvo (não fraciona episódio), desde que
		// não estoure o hard cap: 1000 + 5000 + 9000 = 15000 ≤ 18000
		expect(sel.episodeIds.length).toBe(3);
		expect(sel.totalTokens).toBe(15000);
	});

	it("episódio único maior que o cap é incluído (unidade = episódio)", () => {
		const proj = "proj-s-oversize";
		makeNormalizedEpisode(50_000, proj);
		const sel = selectEpisodesForJob(pipeline, proj, { targetTokens: 1000, hardCap: 18_000 });
		expect(sel.episodeIds.length).toBe(1);
		expect(sel.totalTokens).toBe(50_000);
	});

	it("episódios selected não são re-selecionados", () => {
		const proj = "proj-s-selected";
		const ep = makeNormalizedEpisode(100, proj);
		const jobId = pipeline.createJob(proj, "tokens");
		pipeline.completeJobWithSelection(jobId, [ep], { phase: "selection" });
		const sel = selectEpisodesForJob(pipeline, proj, { targetTokens: 1_000_000 });
		expect(sel.episodeIds.length).toBe(0);
	});
});

describe("chunkEpisodes (divisão de sessão grande)", () => {
	it("divide em chunks até o alvo sem estourar o hard cap", () => {
		const eps = [
			{ tokenEstimate: 4000 },
			{ tokenEstimate: 4000 },
			{ tokenEstimate: 5000 },
			{ tokenEstimate: 1000 },
		] as EpisodeRecord[];
		const chunks = chunkEpisodes(eps, { targetTokens: 8000, hardCap: 18_000 });
		expect(chunks.length).toBe(2);
		expect(chunks[0].length).toBe(2);
		expect(chunks[1].length).toBe(2);
	});

	it("episódio único maior que o cap forma um chunk sozinho", () => {
		const eps = [{ tokenEstimate: 50_000 }] as EpisodeRecord[];
		const chunks = chunkEpisodes(eps, { targetTokens: 1000, hardCap: 18_000 });
		expect(chunks.length).toBe(1);
	});

	it("sessão pequena vira chunk único", () => {
		const eps = [{ tokenEstimate: 100 }, { tokenEstimate: 200 }] as EpisodeRecord[];
		const chunks = chunkEpisodes(eps);
		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBe(2);
	});
});

describe("createSessionJobs (consolidação por sessão)", () => {
	it("cria um job por chunk, pré-vinculado e com episódios selected", () => {
		const proj = "proj-cs-jobs";
		const sess = `sess-${Math.random()}`;
		for (let i = 0; i < 3; i++) {
			const id = pipeline.insertEpisode(
				makeEpisode({ projectId: proj, sessionId: sess, tokenEstimate: 4000 }),
			);
			pipeline.finalizeEpisode(id, [], EPISODE_STATUS.NORMALIZED);
		}
		const jobIds = createSessionJobs(pipeline, proj, sess, JOB_REASONS.SESSION, {
			targetTokens: 8000,
			hardCap: 18_000,
		});
		expect(jobIds.length).toBe(2);
		const linked = pipeline.listEpisodesByJob(jobIds[0]);
		expect(linked.length).toBe(2);
		expect(pipeline.getJob(jobIds[0])!.reason).toBe(JOB_REASONS.SESSION);
		// Episódios do chunk saem de normalized (não são redrenados)
		expect(
			pipeline.listEpisodesBySession(sess, [EPISODE_STATUS.NORMALIZED]).filter((e) => e.projectId === proj)
				.length,
		).toBe(0);
	});

	it("ignora episódios de outro projeto e sessões vazias", () => {
		const sess = `sess-${Math.random()}`;
		const other = pipeline.insertEpisode(
			makeEpisode({ projectId: "proj-cs-other", sessionId: sess, tokenEstimate: 10 }),
		);
		pipeline.finalizeEpisode(other, [], EPISODE_STATUS.NORMALIZED);
		expect(createSessionJobs(pipeline, "proj-cs-empty", sess, JOB_REASONS.SESSION)).toEqual([]);
		expect(createSessionJobs(pipeline, "proj-cs-other", "sess-inexistente", JOB_REASONS.SESSION)).toEqual(
			[],
		);
	});

	it("sem episódios normalized → nenhum job (sem job vazio)", () => {
		expect(
			createSessionJobs(pipeline, "proj-cs-none", `sess-${Math.random()}`, JOB_REASONS.MANUAL),
		).toEqual([]);
	});
});

describe("pending_sessions (shutdown marca, start consolida)", () => {
	it("queue é idempotente; claim → complete", () => {
		const proj = "proj-pend";
		const sess = `sess-${Math.random()}`;
		pipeline.queuePendingSession({
			sessionId: sess,
			projectId: proj,
			sessionFile: "/tmp/s.jsonl",
			reason: "shutdown",
		});
		pipeline.queuePendingSession({
			sessionId: sess,
			projectId: proj,
			sessionFile: "/tmp/s.jsonl",
			reason: "shutdown",
		});
		expect(pipeline.countPendingSessions(proj, PENDING_SESSION_STATUS.PENDING)).toBe(1);
		const claimed = pipeline.claimPendingSessions(proj);
		expect(claimed.length).toBe(1);
		expect(claimed[0].sessionId).toBe(sess);
		expect(pipeline.countPendingSessions(proj, PENDING_SESSION_STATUS.PENDING)).toBe(0);
		pipeline.completePendingSession(sess);
	});

	it("recoverStalePendingSessions resgata claimed órfão de crash", () => {
		const proj = "proj-pend-crash";
		const sess = `sess-${Math.random()}`;
		pipeline.queuePendingSession({
			sessionId: sess,
			projectId: proj,
			sessionFile: "/tmp/s.jsonl",
			reason: "shutdown",
		});
		expect(pipeline.claimPendingSessions(proj).length).toBe(1);
		// Crash aqui: sem complete. O próximo start recupera.
		expect(pipeline.recoverStalePendingSessions()).toBe(1);
		expect(pipeline.countPendingSessions(proj, PENDING_SESSION_STATUS.PENDING)).toBe(1);
		pipeline.completePendingSession(sess);
	});

	it("release devolve para pending", () => {
		const proj = "proj-pend-rel";
		const sess = `sess-${Math.random()}`;
		pipeline.queuePendingSession({
			sessionId: sess,
			projectId: proj,
			sessionFile: "/tmp/s.jsonl",
			reason: "shutdown",
		});
		expect(pipeline.claimPendingSessions(proj).length).toBe(1);
		pipeline.releasePendingSession(sess);
		expect(pipeline.countPendingSessions(proj, PENDING_SESSION_STATUS.PENDING)).toBe(1);
		pipeline.completePendingSession(sess);
	});
});

describe("PipelineWorker", () => {
	it("processa job com sucesso: done + episódios selected + links", async () => {
		const proj = "proj-w-ok";
		const ep = makeNormalizedEpisode(500, proj);
		const jobId = pipeline.createJob(proj, "tokens");
		const w = new PipelineWorker(pipeline, {
			processor: async () => ({ ok: true, details: { phase: "selection" } }),
		});
		w.setProject(proj);
		w.start();
		await waitFor(() => pipeline.getJob(jobId)!.status === JOB_STATUS.DONE);

		expect(pipeline.getEpisode(ep)!.status).toBe(EPISODE_STATUS.SELECTED);
		expect(pipeline.getJob(jobId)!.details).toContain("selection");
		await w.stop();
	});

	it("processor falho → retries até maxAttempts → dead_letter", async () => {
		const proj = "proj-w-retry";
		let calls = 0;
		const failing: JobProcessor = async () => {
			calls++;
			return { ok: false, retryable: true, error: "llm indisponível" };
		};
		const jobId = pipeline.createJob(proj, "tokens");
		const w = new PipelineWorker(pipeline, {
			processor: failing,
			maxAttempts: 2,
			backoffMs: [0, 0],
		});
		w.setProject(proj);
		w.start();
		await waitFor(() => pipeline.getJob(jobId)!.status === JOB_STATUS.DEAD_LETTER);

		expect(pipeline.getJob(jobId)!.error).toContain("llm indisponível");
		expect(calls).toBe(3); // 1 inicial + 2 retries (maxAttempts=2)
		await w.stop();
	});

	it("processor que lança é tratado como retryável", async () => {
		const proj = "proj-w-throw";
		const throwing: JobProcessor = async () => {
			throw new Error("boom");
		};
		const jobId = pipeline.createJob(proj, "tokens");
		const w = new PipelineWorker(pipeline, { processor: throwing, maxAttempts: 1, backoffMs: [0] });
		w.setProject(proj);
		w.start();
		await waitFor(() => pipeline.getJob(jobId)!.status === JOB_STATUS.DEAD_LETTER);

		expect(pipeline.getJob(jobId)!.error).toContain("boom");
		await w.stop();
	});

	it("não processa jobs de outro projeto até setProject trocar", async () => {
		const jobB = pipeline.createJob("proj-w-b", "tokens");
		const w = new PipelineWorker(pipeline);
		w.setProject("proj-w-a");
		w.start();
		await new Promise((r) => setTimeout(r, 60));
		expect(pipeline.getJob(jobB)!.status).toBe(JOB_STATUS.QUEUED);

		w.setProject("proj-w-b");
		await waitFor(() => pipeline.getJob(jobB)!.status === JOB_STATUS.DONE);
		await w.stop();
	});

	it("stop sem start é seguro e start é idempotente", async () => {
		const w = new PipelineWorker(pipeline);
		await w.stop(); // nunca iniciado — não lança
		w.start();
		w.start(); // idempotente
		await w.stop();
		expect(w.isRunning).toBeFalse();
	});

	it("stop aborta o job em processamento (signal no processor)", async () => {
		const proj = "proj-w-abort";
		pipeline.createJob(proj, "tokens");
		let receivedSignal: AbortSignal | undefined;
		let resolved = false;
		const w = new PipelineWorker(pipeline, {
			processor: async (_p, _job, _sel, signal) => {
				receivedSignal = signal;
				// Simula chamada LLM longa que respeita o signal
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve());
				});
				resolved = true;
				return { ok: true };
			},
		});
		w.setProject(proj);
		w.start();
		await waitFor(() => receivedSignal !== undefined);

		const stopPromise = w.stop();
		await waitFor(() => resolved); // abort liberou o processador
		await stopPromise;

		expect(receivedSignal?.aborted).toBeTrue();
		expect(w.isRunning).toBeFalse();
	});

	it("setProject aborta o job em processamento do projeto anterior", async () => {
		const projA = "proj-w-abort-switch-a";
		const projB = "proj-w-abort-switch-b";
		pipeline.createJob(projA, "tokens");
		let receivedSignal: AbortSignal | undefined;
		let resolved = false;
		const w = new PipelineWorker(pipeline, {
			processor: async (_p, _job, _sel, signal) => {
				receivedSignal = signal;
				// Simula chamada LLM longa que respeita o signal
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve());
				});
				resolved = true;
				return { ok: false, retryable: true, error: "abortado por troca de projeto" };
			},
		});
		w.setProject(projA);
		w.start();
		await waitFor(() => receivedSignal !== undefined);

		// Troca de projeto no meio da extração → aborta o job de A.
		w.setProject(projB);
		await waitFor(() => resolved);

		expect(receivedSignal?.aborted).toBeTrue();
		// O job de A não é processado como done — fica retryável para quando
		// o projeto A voltar a ser ativo.
		await w.stop();
	});

	it("episódios normalizados durante o job NÃO abrem novo job (sem gatilho automático)", async () => {
		const proj = "proj-w-no-retrigger";
		makeNormalizedEpisode(100, proj);
		const jobA = pipeline.createJob(proj, JOB_REASONS.MANUAL);
		let injected = false;
		const w = new PipelineWorker(pipeline, {
			includeClaimed: true, // como o index.ts configura
			processor: async (_p, _job, _sel) => {
				// Simula agent_settled DURANTE o job: episódios novos que
				// ficam normalized até o próximo compact/start/manual.
				if (!injected) {
					injected = true;
					for (let i = 0; i < 5; i++) makeNormalizedEpisode(100, proj);
				}
				return { ok: true, episodesStatus: "processed" };
			},
		});
		w.setProject(proj);
		w.start();
		await waitFor(() => pipeline.getJob(jobA)!.status === JOB_STATUS.DONE);
		await new Promise((r) => setTimeout(r, 100));
		// Nenhum job automático: os 5 novos aguardam compact/shutdown/manual.
		expect(pipeline.countJobs(proj)).toBe(1);
		expect(
			pipeline.listEpisodesByStatuses(proj, [EPISODE_STATUS.NORMALIZED]).length,
		).toBe(5);
		await w.stop();
	});

	it("job pré-vinculado processa só seus episódios (chunk de sessão)", async () => {
		const proj = "proj-w-linked";
		const sess = `sess-${Math.random()}`;
		for (let i = 0; i < 3; i++) {
			const id = pipeline.insertEpisode(
				makeEpisode({ projectId: proj, sessionId: sess, tokenEstimate: 100 }),
			);
			pipeline.finalizeEpisode(id, [], EPISODE_STATUS.NORMALIZED);
		}
		const jobIds = createSessionJobs(pipeline, proj, sess, JOB_REASONS.COMPACT);
		expect(jobIds.length).toBe(1);
		let seen: string[] = [];
		const w = new PipelineWorker(pipeline, {
			processor: async (_p, _job, sel) => {
				seen = sel.episodeIds;
				return { ok: true, episodesStatus: EPISODE_STATUS.PROCESSED };
			},
		});
		w.setProject(proj);
		w.start();
		await waitFor(() => pipeline.getJob(jobIds[0])!.status === JOB_STATUS.DONE);
		expect(seen.length).toBe(3);
		expect(
			pipeline.listEpisodesBySession(sess, [EPISODE_STATUS.PROCESSED]).length,
		).toBe(3);
		await w.stop();
	});
});
