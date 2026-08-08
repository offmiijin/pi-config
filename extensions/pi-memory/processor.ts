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
	type EvidenceRecord,
	type JobRecord,
	type NewCandidate,
	type PipelineDB,
} from "./pipeline.ts";
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
 * Cria o processor de extração usado pelo worker. Fluxo: evidências → termos
 * de busca → memórias relacionadas → prompt → complete() → parse → insere
 * candidatos (idempotente) → métricas no job → ok com episódios processed.
 */
export function createExtractionProcessor(deps: ExtractionProcessorDeps): JobProcessor {
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
			const { candidates, ignored } = parseExtractionResponse(responseText);
			const inserted = pipeline.insertCandidates(
				job.id,
				candidates.map((c) => toNewCandidate(job.id, c)),
			);

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
