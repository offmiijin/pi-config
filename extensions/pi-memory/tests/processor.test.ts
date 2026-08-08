/**
 * pi-memory — Tests: processor de extração (Fase 3) com modelo fake.
 *
 * Usa banco temporário + model fake — nenhuma chamada LLM real. Testa o fluxo
 * evidências → prompt → complete() → candidates no banco + métricas no job.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	EPISODE_STATUS,
	PipelineDB,
	type NewEvidence,
	type NewEpisode,
} from "../pipeline.ts";
import { selectEpisodesForJob } from "../worker.ts";
import {
	createExtractionProcessor,
	type CompletionOptions,
	type ExtractionModelRef,
} from "../processor.ts";

let tmpDir: string;
let pipeline: PipelineDB;

function makeEpisode(projectId: string): NewEpisode {
	return {
		projectId,
		sessionId: `sess-${Math.random()}`,
		sessionFile: "/tmp/sess.jsonl",
		startEntryId: "a",
		endEntryId: "b",
		leafId: "b",
		fingerprint: `fp-${Math.random()}`,
		tokenEstimate: 500,
	};
}

/** Insere episódio com evidência de correção + bash e devolve (episodeId, evId). */
function makeEpisodeWithEvidence(projectId: string): { episodeId: string; evidenceId: string } {
	const episodeId = pipeline.insertEpisode(makeEpisode(projectId));
	const ev: NewEvidence = {
		episodeId,
		kind: "correction",
		payloadJson: JSON.stringify({ text: "não, a sessão expira com cache" }),
		contentHash: `h-${Math.random()}`,
		tokenEstimate: 20,
		redactionFlags: 0,
		isError: 0,
		priority: 2,
	};
	pipeline.finalizeEpisode(episodeId, [ev], EPISODE_STATUS.NORMALIZED);
	return { episodeId, evidenceId: pipeline.listEvidenceByEpisode(episodeId)[0].id };
}

function makeFakeModel(responseText: string, usage?: { inputTokens: number; outputTokens: number }) {
	return {
		provider: "fake",
		id: "fake-model",
		complete: async () => ({
			content: [{ type: "text", text: responseText }],
			...(usage ? { usage } : {}),
		}),
	} satisfies ExtractionModelRef & { complete: () => Promise<{ content: { type: string; text: string }[]; usage?: unknown }> };
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-processor-"));
	pipeline = new PipelineDB(join(tmpDir, ".pipeline.sqlite"));
	pipeline.open();
});

afterAll(() => {
	pipeline.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("createExtractionProcessor", () => {
	it("extrai candidatos e registra no banco + métricas no job", async () => {
		const proj = "proj-x-ok";
		const { evidenceId } = makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		const response = JSON.stringify({
			memories: [
				{
					action: "create",
					context: "sessao-cache",
					type: "gotchas",
					scope: "project",
					title: "Cache de sessão",
					summary: "Sessão expira com cache",
					content: "A sessão expira…",
					confidence: 0.8,
					evidence_ids: [evidenceId],
				},
				{ action: "ignore", context: "nada", reason: "transitório" },
			],
		});
		const model = makeFakeModel(response, { inputTokens: 150, outputTokens: 30 });
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "- [project/gotchas/sessao-cache] (0.7) Antiga",
		});

		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		const result = await processor(pipeline, job, selection);

		expect(result.ok).toBeTrue();
		expect(result.episodesStatus).toBe("processed");
		expect(result.details?.candidates).toBe(1);
		expect(result.details?.ignored).toBe(1);

		const candidates = pipeline.listCandidatesByJob(jobId);
		expect(candidates.length).toBe(1);
		expect(candidates[0].context).toBe("sessao-cache");
		expect(candidates[0].evidenceIds).toEqual([evidenceId]);
		expect(candidates[0].status).toBe("pending");

		const updated = pipeline.getJob(jobId)!;
		expect(updated.model).toBe("fake/fake-model");
		expect(updated.inputTokens).toBe(150);
		expect(updated.outputTokens).toBe(30);
		expect(updated.promptVersion).toBe(1);
	});

	it("é idempotente: re-execução substitui candidatos do job", async () => {
		const proj = "proj-x-idem";
		makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		const response = JSON.stringify({ memories: [{
			action: "create", context: "ctx-idem", type: "lessons", scope: "project",
			title: "T", summary: "S", content: "C", confidence: 0.7, evidence_ids: [],
		}] });
		const model = makeFakeModel(response);
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
		});

		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		await processor(pipeline, job, selection);
		await processor(pipeline, job, selection);

		expect(pipeline.countCandidates(jobId)).toBe(1); // substituído, não duplicado
	});

	it("sem modelo configurado → retryável com erro claro", async () => {
		const proj = "proj-x-nomodel";
		makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");
		const processor = createExtractionProcessor({
			getModel: async () => null,
			getRelatedMemories: async () => "",
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });

		const result = await processor(pipeline, job, selection);
		expect(result.ok).toBeFalse();
		expect(result.retryable).toBeTrue();
		expect(result.error).toContain("não configurado");
	});

	it("complete lança → retryável com erro", async () => {
		const proj = "proj-x-throw";
		makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");
		const failing: ExtractionModelRef = {
			provider: "fake",
			id: "fake",
			complete: async () => {
				throw new Error("rate limit 429");
			},
		};
		const processor = createExtractionProcessor({
			getModel: async () => failing,
			getRelatedMemories: async () => "",
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });

		const result = await processor(pipeline, job, selection);
		expect(result.ok).toBeFalse();
		expect(result.retryable).toBeTrue();
		expect(result.error).toContain("429");
	});

	it("resposta inválida → job ok com 0 candidatos", async () => {
		const proj = "proj-x-badresp";
		makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");
		const model = makeFakeModel("isto não é JSON");
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });

		const result = await processor(pipeline, job, selection);
		expect(result.ok).toBeTrue();
		expect(result.details?.candidates).toBe(0);
	});

	it("passa reasoning/cache configurados na chamada", async () => {
		const proj = "proj-x-opts";
		makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		let captured: CompletionOptions | null = null;
		const model: ExtractionModelRef = {
			provider: "fake",
			id: "fake",
			complete: async (_msgs, opts) => {
				captured = opts;
				return { content: [{ type: "text", text: JSON.stringify({ memories: [] }) }] };
			},
		};
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		await processor(pipeline, job, selection);

		expect(captured?.reasoningEffort).toBe("medium");
		expect(captured?.cacheRetention).toBe("default");
		expect(captured?.sessionId.length).toBeGreaterThan(0);
	});
});
