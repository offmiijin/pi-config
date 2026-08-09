/**
 * pi-memory — Processor de extração (Fase 3).
 *
 * Converte um job em memórias candidatas: lê as evidências dos episódios
 * selecionados, busca memórias relacionadas, monta o prompt, chama o modelo
 * de extração (config.ts) e persiste os candidatos (candidates) vinculados
 * ao job. O worker cuida do ciclo de vida do job; este processor retorna
 * ok/retryable + episódios → processed.
 *
 * Dependências injetadas (getModel/getRelatedMemories) — o módulo é testável
 * com fakes sem tocar no runtime do Pi.
 */

import { randomUUID } from "node:crypto";

import {
	EXTRACTION_CACHE_RETENTION,
	EXTRACTION_MODEL_ID,
	EXTRACTION_MODEL_PROVIDER,
	EXTRACTION_PROMPT_VERSION,
	EXTRACTION_REASONING,
} from "./config.ts";
import {
	buildEvidenceText,
	buildExtractionPrompt,
	extractSearchTerms,
	parseExtractionResponse,
	type EvidenceBlock,
} from "./extractor.ts";
import {
	CANDIDATE_STATUS,
	type CandidateRecord,
	type EvidenceRecord,
	type JobRecord,
	type NewCandidate,
	type PipelineDB,
} from "./pipeline.ts";
import {
	buildReviewPrompt,
	classifyCandidate,
	describeCandidate,
	parseReviewResponse,
	rejectionReason,
	validateCandidate,
	type MemoryFileRef,
	type ReviewDecision,
} from "./validator.ts";
import type { JobExecutionResult, JobProcessor, SelectedEpisodes } from "./worker.ts";

/* ------------------------------------------------------------------ */
/* Tipos de integração com o modelRegistry do Pi                       */
/* ------------------------------------------------------------------ */

export interface CompletionMessage {
	role: "user";
	content: { type: "text"; text: string }[];
	timestamp: number;
}

export interface CompletionOptions {
	reasoningEffort: string;
	cacheRetention: string;
	sessionId: string;
}

export interface CompletionResponse {
	content: { type: string; text?: string }[];
	usage?: { inputTokens?: number; outputTokens?: number; input?: number; output?: number };
}

export type CompleteFn = (
	messages: CompletionMessage[],
	opts: CompletionOptions,
) => Promise<CompletionResponse>;

/** Modelo de extração resolvido (registry.find + auth ok). */
export interface ExtractionModelRef {
	provider: string;
	id: string;
	complete: CompleteFn;
}

/** Superfície mínima do modelRegistry usada pelo processor. */
export interface ModelRegistryLike {
	find(provider: string, id: string): { id: string; provider: string } | undefined;
	hasConfiguredAuth(model: { id: string }): boolean;
	complete(
		model: { id: string; provider: string },
		req: { messages: CompletionMessage[] },
		opts: CompletionOptions,
	): Promise<CompletionResponse>;
}

export interface ExtractionProcessorDeps {
	getModel(): Promise<ExtractionModelRef | null>;
	getRelatedMemories(projectId: string, terms: string[]): Promise<string>;
	/**
	 * Fase 4: localiza memória existente pelo context key (dedup/contradição
	 * e validação de supersede). Default: nenhuma.
	 */
	findExistingMemory?(context: string): Promise<MemoryFileRef | null>;
	/**
	 * Fase 4: grava a memória (markdown + índice). Default: no-op ok.
	 */
	commitMemory?(candidate: CandidateRecord): Promise<{ ok: boolean; error?: string }>;
}

/* ------------------------------------------------------------------ */
/* Coleta de evidências                                                */
/* ------------------------------------------------------------------ */

function toEvidenceBlock(ev: EvidenceRecord): EvidenceBlock {
	let text = "";
	try {
		text = (JSON.parse(ev.payloadJson) as { text?: string }).text ?? "";
	} catch {
		text = ev.payloadJson;
	}
	return {
		id: ev.id,
		episodeId: ev.episodeId,
		kind: ev.kind,
		toolName: ev.toolName,
		text,
	};
}

/** Lê as evidências dos episódios selecionados (ordem dos episódios). */
export function collectEvidenceBlocks(
	pipeline: PipelineDB,
	selection: SelectedEpisodes,
): EvidenceBlock[] {
	const blocks: EvidenceBlock[] = [];
	for (const ep of selection.episodes) {
		for (const ev of pipeline.listEvidenceByEpisode(ep.id)) {
			blocks.push(toEvidenceBlock(ev));
		}
	}
	return blocks;
}

/** Converte candidato do modelo em linha da tabela candidates. */
export function toNewCandidate(jobId: string, c: {
	action: string;
	context: string;
	type?: string;
	scope?: string;
	title?: string;
	summary?: string;
	content?: string;
	confidence?: number;
	evidence_ids?: string[];
	supersedes?: string | null;
}): NewCandidate {
	return {
		jobId,
		action: c.action,
		context: c.context,
		type: c.type ?? null,
		scope: c.scope ?? null,
		title: c.title ?? null,
		summary: c.summary ?? null,
		content: c.content ?? null,
		confidence: c.confidence ?? null,
		evidenceIds: c.evidence_ids ?? [],
		supersedes: c.supersedes ?? null,
		status: CANDIDATE_STATUS.PENDING,
	};
}

/* ------------------------------------------------------------------ */
/* Processor                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cria o processor de extração usado pelo worker. Fluxo:
 * 1. Extração (Fase 3): evidências → termos → memórias relacionadas → prompt
 *    → complete() → parse → candidatos no banco (idempotente).
 * 2. Validação + commit (Fase 4): para cada candidato, validação
 *    determinística → política (auto-accept | review | reject) → revisor
 *    condicional (mesmo modelo, reasoning low) para casos sensíveis →
 *    commit via deps.commitMemory → status committed/rejected/pending.
 */
export function createExtractionProcessor(deps: ExtractionProcessorDeps): JobProcessor {
	const findExistingMemory = deps.findExistingMemory ?? (async () => null);
	const commitMemory = deps.commitMemory ?? (async () => ({ ok: true }));

	return async (pipeline, job, selection): Promise<JobExecutionResult> => {
		const model = await deps.getModel();
		if (!model) {
			return {
				ok: false,
				retryable: true,
				error:
					`modelo de extração não configurado (${EXTRACTION_MODEL_PROVIDER}/` +
					`${EXTRACTION_MODEL_ID}) ou sem auth`,
			};
		}

		try {
			const blocks = collectEvidenceBlocks(pipeline, selection);
			const evidenceText = buildEvidenceText(blocks);
			const terms = extractSearchTerms(blocks);
			const existingMemories = await deps.getRelatedMemories(job.projectId, terms);
			const prompt = buildExtractionPrompt({ evidence: evidenceText, existingMemories });

			const response = await model.complete(
				[{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				{
					reasoningEffort: EXTRACTION_REASONING,
					cacheRetention: EXTRACTION_CACHE_RETENTION,
					sessionId: randomUUID(),
				},
			);

			const responseText = response.content
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n");
			const { candidates, ignored, parseError } = parseExtractionResponse(responseText);

			// Resposta inválida (vazia/JSON quebrado/schema errado) NÃO é
			// sucesso: retry do job — episódios continuam elegíveis e o lote
			// não se perde como "processado sem memórias".
			if (parseError) {
				return { ok: false, retryable: true, error: parseError };
			}

			const inserted = pipeline.insertCandidates(
				job.id,
				candidates.map((c) => toNewCandidate(job.id, c)),
			);

			// Fase 4: validação + política + revisor + commit
			const validEvidenceIds = new Set(blocks.map((b) => b.id));
			let committed = 0;
			let rejected = 0;
			let reviewed = 0;
			let pending = 0;

			for (const candidate of pipeline.listCandidatesByJob(job.id)) {
				const existing = await findExistingMemory(candidate.context);
				const existingSupersedeTarget =
					candidate.action === "supersede" && candidate.supersedes
						? await findExistingMemory(candidate.supersedes)
						: null;
				const issues = validateCandidate(candidate, {
					existing,
					existingSupersedeTarget,
					validEvidenceIds,
				});
				const decision = classifyCandidate(candidate, issues, existing);

				if (decision === "reject") {
					pipeline.updateCandidateStatus(candidate.id, CANDIDATE_STATUS.REJECTED, rejectionReason(issues));
					rejected++;
					continue;
				}

				if (decision === "review") {
					reviewed++;
					const review = await runReviewer(model, candidate, blocks, existing);
					if (!review) {
						// Revisor indisponível → candidato fica pending (revisão futura).
						pending++;
						continue;
					}
					if (review.action === "reject") {
						pipeline.updateCandidateStatus(candidate.id, CANDIDATE_STATUS.REJECTED, review.reason);
						rejected++;
						continue;
					}
					if (review.action === "modify" && review.modified) {
						applyReviewModifications(candidate, review.modified);
					}
					// accept ou modify → commit
					const reviewCommit = await commitMemory(candidate);
					if (reviewCommit.ok) {
						pipeline.updateCandidateStatus(candidate.id, CANDIDATE_STATUS.COMMITTED);
						committed++;
					} else {
						pipeline.updateCandidateStatus(candidate.id, CANDIDATE_STATUS.PENDING, reviewCommit.error);
						pending++;
					}
					continue;
				}

				// auto-accept
				const acceptCommit = await commitMemory(candidate);
				if (acceptCommit.ok) {
					pipeline.updateCandidateStatus(candidate.id, CANDIDATE_STATUS.COMMITTED);
					committed++;
				} else {
					pipeline.updateCandidateStatus(candidate.id, CANDIDATE_STATUS.PENDING, acceptCommit.error);
					pending++;
				}
			}

			const inputTokens = response.usage?.inputTokens ?? response.usage?.input ?? 0;
			const outputTokens = response.usage?.outputTokens ?? response.usage?.output ?? 0;
			pipeline.updateJob(job.id, {
				model: `${model.provider}/${model.id}`,
				reasoningLevel: EXTRACTION_REASONING,
				promptVersion: EXTRACTION_PROMPT_VERSION,
				inputTokens,
				outputTokens,
			});

			return {
				ok: true,
				episodesStatus: "processed",
				details: {
					phase: "extraction",
					candidates: inserted,
					ignored,
					committed,
					rejected,
					reviewed,
					pending,
					promptVersion: EXTRACTION_PROMPT_VERSION,
					inputTokens,
					outputTokens,
				},
			};
		} catch (err) {
			return {
				ok: false,
				retryable: true,
				error: (err as Error).message ?? String(err),
			};
		}
	};
}

/** Aplica correções do revisor (modify) no registro em memória. */
function applyReviewModifications(candidate: CandidateRecord, modified: Partial<CandidateRecord>): void {
	if (typeof modified.title === "string") candidate.title = modified.title;
	if (typeof modified.summary === "string") candidate.summary = modified.summary;
	if (typeof modified.content === "string") candidate.content = modified.content;
	if (typeof modified.confidence === "number") candidate.confidence = modified.confidence;
	if (modified.scope === "global" || modified.scope === "project") candidate.scope = modified.scope;
	if (typeof modified.type === "string") candidate.type = modified.type;
}

/**
 * Chama o revisor (mesmo modelo, reasoning low). Evidências filtradas pelas
 * evidence_ids do candidato, orçamento compacto (~3K tokens). Falha → null
 * (candidato permanece pending — não decide sem revisor).
 */
async function runReviewer(
	model: ExtractionModelRef,
	candidate: CandidateRecord,
	blocks: EvidenceBlock[],
	existing: MemoryFileRef | null,
): Promise<ReviewDecision | null> {
	const relevant = blocks.filter((b) => candidate.evidenceIds.includes(b.id));
	const evidence = buildEvidenceText(relevant, 3_000);
	const prompt = buildReviewPrompt({
		candidate: describeCandidate(candidate),
		evidence,
		existing: existing?.content ?? null,
	});
	try {
		const response = await model.complete(
			[{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			{
				reasoningEffort: "low",
				cacheRetention: EXTRACTION_CACHE_RETENTION,
				sessionId: randomUUID(),
			},
		);
		const text = response.content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
		return parseReviewResponse(text);
	} catch {
		return null;
	}
}
