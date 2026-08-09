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

	it("passa reasoning/cache/maxTokens/sessionId fixo na chamada", async () => {
		const proj = "proj-x-opts";
		makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		// Array em vez de `let x = null` capturado por closure — TS 5.9 com
		// strictNullChecks estreita a variável capturada para never.
		const captured: CompletionOptions[] = [];
		const model: ExtractionModelRef = {
			provider: "fake",
			id: "fake",
			complete: async (_msgs, opts) => {
				captured.push(opts);
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

		expect(captured[0]?.reasoningEffort).toBe("low");
		// "short" (não "default" — valor inválido na API de cache)
		expect(captured[0]?.cacheRetention).toBe("short");
		// Teto de saída: evita output de 15K tokens sem controle
		expect(captured[0]?.maxTokens).toBe(4096);
		// sessionId FIXO (não UUID por chamada) — cache de prompt reutilizável
		expect(captured[0]?.sessionId).toBe("pi-memory-extraction");
	});

	it("passa projectId do job para findExistingMemory/commitMemory", async () => {
		const proj = "proj-x-jobid";
		const { evidenceId } = makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		const seenProjects: string[] = [];
		const model = makeFakeModel(
			JSON.stringify({
				memories: [
					{
						action: "create",
						context: "ctx-jobid",
						type: "lessons",
						scope: "project",
						title: "T",
						summary: "S",
						content: "C",
						confidence: 0.8,
						evidence_ids: [evidenceId],
					},
				],
			}),
		);
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
			findExistingMemory: async (projectId) => {
				seenProjects.push(projectId);
				return null;
			},
			commitMemory: async (projectId) => {
				seenProjects.push(projectId);
				return { ok: true };
			},
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		await processor(pipeline, job, selection);

		expect(seenProjects.length).toBeGreaterThan(0);
		expect(seenProjects.every((p) => p === proj)).toBeTrue();
	});

	it("limita candidatos por job (top N por confidence)", async () => {
		const proj = "proj-x-limit";
		const { evidenceId } = makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		// 10 candidatos válidos (confidence 0.95 → 0.77, todos ≥ 0.75 →
		// auto-accept) — o teto de 8 deve rejeitar os 2 de menor confidence.
		const memories = Array.from({ length: 10 }, (_, i) => ({
			action: "create",
			context: `ctx-limit-${i}`,
			type: "lessons",
			scope: "project",
			title: `T${i}`,
			summary: `S${i}`,
			content: `C${i}`,
			confidence: 0.95 - i * 0.02,
			evidence_ids: [evidenceId],
		}));
		const model = makeFakeModel(JSON.stringify({ memories }));
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
			findExistingMemory: async () => null,
			commitMemory: async () => ({ ok: true }),
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		const result = await processor(pipeline, job, selection);

		const candidates = pipeline.listCandidatesByJob(jobId);
		expect(result.details?.committed).toBe(8);
		expect(result.details?.rejected).toBe(2);
		expect(candidates.filter((c) => c.status === "committed").length).toBe(8);
		const excess = candidates.filter((c) => c.status === "rejected");
		expect(excess.length).toBe(2);
		// Excedentes são os de MENOR confidence (ctx-limit-8 e ctx-limit-9).
		expect(excess.every((c) => c.rejectionReason?.includes("excedeu limite"))).toBeTrue();
		expect(excess.map((c) => c.context).sort()).toEqual(["ctx-limit-8", "ctx-limit-9"]);
	});

	it("agrega uso de tokens do revisor nas métricas do job", async () => {
		const proj = "proj-x-revusage";
		const { evidenceId } = makeEpisodeWithEvidence(proj);
		const jobId = pipeline.createJob(proj, "tokens");

		let calls = 0;
		const model: ExtractionModelRef = {
			provider: "fake",
			id: "fake",
			complete: async (messages) => {
				calls++;
				const text = messages
					.map((m) => m.content.map((c) => c.text ?? "").join(""))
					.join("");
				if (text.includes("Revise esta memória candidata")) {
					// Revisor: aceita com uso próprio
					return {
						content: [{ type: "text", text: '{"action":"accept","reason":"ok"}' }],
						usage: { inputTokens: 500, outputTokens: 60 },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								memories: [
									{
										action: "create",
										context: "ctx-revusage",
										type: "_rules",
										scope: "project",
										title: "T",
										summary: "S",
										content: "C",
										confidence: 0.9,
										evidence_ids: [evidenceId],
									},
								],
							}),
						},
					],
					usage: { inputTokens: 200, outputTokens: 40 },
				};
			},
		};
		const processor = createExtractionProcessor({
			getModel: async () => model,
			getRelatedMemories: async () => "",
			findExistingMemory: async () => null,
			commitMemory: async () => ({ ok: true }),
		});
		const job = pipeline.getJob(jobId)!;
		const selection = selectEpisodesForJob(pipeline, proj, { includeClaimed: true });
		await processor(pipeline, job, selection);

		const updated = pipeline.getJob(jobId)!;
		expect(calls).toBe(2); // extração + revisor
		expect(updated.inputTokens).toBe(200 + 500);
		expect(updated.outputTokens).toBe(40 + 60);
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
			commitMemory: async (_projectId, c) => {
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

	it("revisor modify inválido (tipo/confidence) → rejected sem commit", async () => {
		const { result, candidates, commits } = await runOnce(
			"proj-f4-modify-invalid",
			(evId) => candidateJson({ type: "_rules" }, [evId]),
			'{"action":"modify","reason":"ajustes","modified":{"type":"gotcha","confidence":0.2}}',
		);
		// Revalidação pós-modificação: tipo "gotcha" (inválido) e confidence 0.2
		// (fora de [0.5, 1]) — o modify NÃO pode contornar a validação
		// determinística. Candidato rejeitado, nada commitado.
		expect(result.details?.rejected).toBe(1);
		expect(commits.length).toBe(0);
		expect(candidates[0].status).toBe("rejected");
		expect(candidates[0].rejectionReason).toContain("tipo");
		expect(candidates[0].rejectionReason).toContain("confidence");
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

	it("revisor indisponível → candidato pending e job retryável", async () => {
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
		// Candidato pending NÃO deixa o job done — retry do MESMO job com
		// backoff (episódios continuam elegíveis; no retry o pending resolve
		// ou vira dead_letter após maxAttempts).
		expect(result.ok).toBeFalse();
		expect(result.retryable).toBeTrue();
		expect(result.error).toContain("pendente");
	});

	it("falha no commit → candidato pending e job retryável", async () => {
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
		// Job retryável — o commit será retentado com backoff, não abandonado.
		expect(result.ok).toBeFalse();
		expect(result.retryable).toBeTrue();
	});
});
