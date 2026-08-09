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
		expect(candidates[0].status).toBe("committed"); // auto-accept (Fase 4)

		const updated = pipeline.getJob(jobId)!;
		expect(updated.model).toBe("fake/fake-model");
		expect(updated.inputTokens).toBe(150);
		expect(updated.outputTokens).toBe(30);
		expect(updated.promptVersion).toBe(1);
		expect(result.details?.committed).toBe(1);
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

	it("resposta inválida → retryável com erro (episódios não se perdem)", async () => {
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
		expect(result.ok).toBeFalse();
		expect(result.retryable).toBeTrue();
		expect(result.error).toContain("JSON");
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

describe("Fase 4: validação, revisor e commit", () => {
	type Messages = { content: { type: string; text?: string }[] }[];

	/** Fake que distingue o prompt de extração do prompt do revisor. */
	function makeSmartFake(
		extractionResponse: string,
		reviewResponse?: string | (() => { content: { type: string; text: string }[] }),
	) {
		return {
			provider: "fake",
			id: "fake-model",
			complete: async (messages: Messages) => {
				const text = messages
					.map((m) => m.content.map((c) => c.text ?? "").join(""))
					.join("");
				if (text.includes("Revise esta memória candidata")) {
					if (typeof reviewResponse === "function") return reviewResponse();
					return { content: [{ type: "text", text: reviewResponse ?? '{"action":"accept","reason":"ok"}' }] };
			}
			return { content: [{ type: "text", text: extractionResponse }] };
		},
	};
	}

	const candidateJson = (over: Record<string, unknown> = {}, evidenceIds: string[] = []) =>
		JSON.stringify({
			memories: [
				{
					action: "create",
					context: "ctx-f4",
					type: "gotchas",
					scope: "project",
					title: "Bug de cache",
					summary: "Cache invalida errado",
					content: "A invalidação do cache acontecia depois da leitura.",
					confidence: 0.8,
					evidence_ids: evidenceIds,
					...over,
				},
			],
		});

	async function runOnce(
		proj: string,
		buildResponse: (evidenceId: string) => string,
		reviewResponse?: string | (() => { content: { type: string; text: string }[] }),
	) {
		const { evidenceId } = makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");
		const commits: { title: string | null; context: string }[] = [];
		const model = makeSmartFake(buildResponse(evidenceId), reviewResponse);
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
			findExistingMemory: async () => null,
			commitMemory: async (c) => {
				commits.push({ title: c.title, context: c.context });
				return { ok: true };
			},
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		const result = await processor(pipeline, job, selection);
		const candidates = pipeline.listCandidatesByJob(jobId);
		return { result, candidates, commits, jobId };
	}

	it("auto-accept commita e marca committed", async () => {
		const { result, candidates, commits } = await runOnce(
			"proj-f4-accept",
			(evId) => candidateJson({}, [evId]),
		);
		expect(result.details?.committed).toBe(1);
		expect(commits.length).toBe(1);
		expect(candidates[0].status).toBe("committed");
		// Sem pendings → episódios podem ser marcados processed
		expect(result.episodesStatus).toBe("processed");
	});

	it("rejeição determinística (conf 0.4) → rejected sem commit", async () => {
		const { result, candidates, commits } = await runOnce(
			"proj-f4-reject",
			(evId) => candidateJson({ confidence: 0.4 }, [evId]),
		);
		expect(result.details?.rejected).toBe(1);
		expect(commits.length).toBe(0);
		expect(candidates[0].status).toBe("rejected");
		expect(candidates[0].rejectionReason).toContain("confidence");
	});

	it("_rules → revisor; accept → committed", async () => {
		const { result, candidates, commits } = await runOnce(
			"proj-f4-review",
			(evId) => candidateJson({ type: "_rules" }, [evId]),
			'{"action":"accept","reason":"regra durável"}',
		);
		expect(result.details?.reviewed).toBe(1);
		expect(commits.length).toBe(1);
		expect(candidates[0].status).toBe("committed");
	});

	it("revisor modify → commit com correções", async () => {
		const { commits } = await runOnce(
			"proj-f4-modify",
			(evId) => candidateJson({ type: "_rules" }, [evId]),
			'{"action":"modify","reason":"título melhor","modified":{"title":"Regra: invalidação antes da leitura"}}',
		);
		expect(commits[0].title).toBe("Regra: invalidação antes da leitura");
	});

	it("revisor reject → rejected sem commit", async () => {
		const { result, candidates, commits } = await runOnce(
			"proj-f4-rev-reject",
			(evId) => candidateJson({ type: "_rules" }, [evId]),
			'{"action":"reject","reason":"não é regra, é caso pontual"}',
		);
		expect(result.details?.rejected).toBe(1);
		expect(commits.length).toBe(0);
		expect(candidates[0].status).toBe("rejected");
		expect(candidates[0].rejectionReason).toContain("caso pontual");
	});

	it("revisor indisponível → candidato fica pending", async () => {
		const { result, candidates, commits } = await runOnce(
			"proj-f4-pending",
			(evId) => candidateJson({ type: "_rules" }, [evId]),
			() => {
				throw new Error("revisor fora do ar");
			},
		);
		expect(result.details?.pending).toBe(1);
		expect(commits.length).toBe(0);
		expect(candidates[0].status).toBe("pending");
		// Pendings não resolvidos → episódios ficam selected (re-elegíveis p/
		// o próximo job — includeClaimed: true re-seleciona sem perda).
		expect(result.episodesStatus).toBe("selected");
	});

	it("falha no commit → candidato fica pending com erro", async () => {
		const proj = "proj-f4-commitfail";
		const { evidenceId } = makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");
		const model = makeSmartFake(candidateJson({}, [evidenceId]));
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
			findExistingMemory: async () => null,
			commitMemory: async () => ({ ok: false, error: "índice quebrado" }),
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		const result = await processor(pipeline, job, selection);
		const candidates = pipeline.listCandidatesByJob(jobId);
		expect(result.details?.pending).toBe(1);
		expect(candidates[0].status).toBe("pending");
		expect(candidates[0].rejectionReason).toContain("índice quebrado");
	});
});
