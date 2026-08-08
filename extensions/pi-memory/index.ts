/**
 * pi-memory — Extensão de memória para o agente PI.
 *
 * Gerencia memórias persistentes (rules, decisions, gotchas, lessons,
 * patterns) nos escopos global e por projeto. Memórias são arquivos markdown
 * ricos agrupados por contexto, buscáveis via índice SQLite FTS5/BM25
 * (fallback ripgrep).
 *
 * Arquitetura (Fases 0-6):
 *   sessão JSONL do Pi → episódios (agent_settled) → evidências →
 *   jobs de extração (gatilhos automáticos ou memory_extract) → worker em
 *   background (prompt + modelo → validação → revisor → commit snapshot).
 *
 * Layout:
 *   index.ts            — estado da extensão + event handlers (wiring)
 *   constants.ts        — constantes compartilhadas + setup de projeto
 *   db.ts               — driver SQLite compartilhado (node/bun)
 *   pipeline.ts         — pipeline operacional (episódios, evidências, jobs)
 *   evidence.ts         — normalização de evidências (Fase 1)
 *   worker.ts           — fila de jobs + consumer assíncrono (Fase 2)
 *   config.ts           — modelo de extração (Fase 3)
 *   extractor.ts        — prompt de extração + parsing (Fase 3)
 *   processor.ts        — extração → validação → commit (Fases 3-4)
 *   validator.ts        — validação/política/revisor (Fase 4)
 *   memory.ts           — CRUD de memórias snapshot v2 + save
 *   memory-index.ts     — índice FTS5 derivado
 *   memory-search.ts    — fallback de busca via ripgrep
 *   session.ts          — helpers legados (estimativa de tokens)
 *   schemas.ts          — schemas de parâmetros das tools
 *   tools/*.ts          — um arquivo por tool (status, save, search, decay, extract)
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ensureDirectories,
	identifyProject,
} from "./constants.ts";
import {
	formatMemoryIndexText,
	findMemoryFile,
	listMemoryIndex,
	parseFrontmatter,
	saveMemory,
} from "./memory.ts";
import {
	INDEX_DB_PATH,
	MemoryIndex,
	readMemoryDocFromFile,
	relFromMemoriesRoot,
} from "./memory-index.ts";
import {
	PIPELINE_DB_PATH,
	PipelineDB,
	buildEpisodeFingerprint,
	estimateEpisodeTokens,
} from "./pipeline.ts";
import { normalizeEpisode } from "./evidence.ts";
import { generateSessionHash, hashSessionFile } from "./session.ts";
import { PipelineWorker, maybeCreateJob } from "./worker.ts";
import {
	EXTRACTION_MODEL_ID,
	EXTRACTION_MODEL_PROVIDER,
} from "./config.ts";
import { formatExistingMemories } from "./extractor.ts";
import {
	createExtractionProcessor,
	type CompletionResponse,
	type ExtractionModelRef,
	type ModelRegistryLike,
} from "./processor.ts";
import type { MemoryFileRef } from "./validator.ts";
import { registerMemoryDecay } from "./tools/decay.ts";
import { registerMemoryExtract } from "./tools/extract.ts";
import { registerMemorySave } from "./tools/save.ts";
import { registerMemorySearch } from "./tools/search.ts";
import { registerMemoryStatus } from "./tools/status.ts";
import type { ToolState } from "./tools/state.ts";

export default function (pi: ExtensionAPI) {
	// Estado compartilhado entre event handlers e tools (tools mutam via referência)
	const state: ToolState = {
		projectId: "",
		currentSessionHash: "",
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
		index: null,
		pipeline: null,
		worker: null,
	};

	// Pipeline operacional (episódios → worker). Null se indisponível —
	// captura de episódio vira no-op com log.
	let pipeline: PipelineDB | null = null;
	// Worker assíncrono: consome jobs do projeto atual. Null se o pipeline
	// não abriu — a fila espera a próxima sessão.
	let worker: PipelineWorker | null = null;
	// Registry de modelos capturado dos event handlers — o processor de
	// extração resolve o modelo FIXO de config.ts em runtime (não herda o
	// modelo interativo da sessão).
	let extractionModelRegistry: ModelRegistryLike | null = null;

	// Resolução do modelo de extração + contexto de memórias relacionadas
	// (FTS5). Melhor-esforço — falha degrada o prompt, não o job.
	const getModel = async (): Promise<ExtractionModelRef | null> => {
		const registry = extractionModelRegistry;
		if (!registry) return null;
		const model = registry.find(EXTRACTION_MODEL_PROVIDER, EXTRACTION_MODEL_ID);
		if (!model) return null;
		if (!registry.hasConfiguredAuth(model)) return null;
		return {
			provider: EXTRACTION_MODEL_PROVIDER,
			id: EXTRACTION_MODEL_ID,
			complete: (messages, opts) =>
				registry.complete(model, { messages }, opts) as unknown as Promise<CompletionResponse>,
		};
	};

	const getRelatedMemories = async (projectId: string, terms: string[]): Promise<string> => {
		const index = state.index;
		if (!index?.isOpen || index.needsRebuild || terms.length === 0) return "";
		try {
			const results = index.search({ terms, scope: "all", projectId, limit: 8 });
			return formatExistingMemories(
				results.map((r) => ({
					scope: r.scope,
					type: r.type,
					context: r.context,
					confidence: r.confidence,
					title: r.title,
					summary: r.summary,
					snippet: r.snippet,
				})),
			);
		} catch {
			return "";
		}
	};

	// Localiza memória existente pelo context key (dedup/contradição e
	// validação de supersede). Best-effort — falha vira "sem memória".
	const findExistingMemory = async (context: string): Promise<MemoryFileRef | null> => {
		try {
			const fp = findMemoryFile(state.projectId, context);
			if (!fp) return null;
			const { meta, body } = parseFrontmatter(readFileSync(fp, "utf-8"));
			return {
				context,
				scope: fp.includes("_global") ? "global" : "project",
				type: typeof meta.type === "string" ? meta.type : "",
				confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
				summary: typeof meta.summary === "string" ? meta.summary : null,
				content: body.trim(),
			};
		} catch {
			return null;
		}
	};

	// Grava a memória no markdown (canônico) e sincroniza o índice FTS5.
	// Falha de índice degrada e segue (próximo syncIncremental reconcilia).
	const commitMemory = async (candidate: {
		context: string;
		action: string;
		type: string | null;
		scope: string | null;
		title: string | null;
		summary: string | null;
		content: string | null;
		confidence: number | null;
		supersedes: string | null;
		evidenceIds: string[];
	}): Promise<{ ok: boolean; error?: string }> => {
		try {
			if (!candidate.type || !candidate.scope || !candidate.title || !candidate.content) {
				return { ok: false, error: "candidato incompleto para commit" };
			}
			const result = saveMemory(state.projectId, {
				type: candidate.type,
				context: candidate.context,
				title: candidate.title,
				content: candidate.content,
				scope: candidate.scope as "global" | "project",
				confidence: candidate.confidence ?? 0.5,
				summary: candidate.summary ?? undefined,
				tags: [],
				evidence: candidate.evidenceIds,
				mode: candidate.action === "update" ? "consolidate" : "append",
				supersedes:
					candidate.action === "supersede" ? candidate.supersedes ?? undefined : undefined,
			});
			if (result.action === "error") return { ok: false, error: result.error };

			if (state.index?.isOpen && result.file) {
				try {
					state.index.syncMutationSafe({
						upsert: [readMemoryDocFromFile(result.file, relFromMemoriesRoot(result.file))],
						remove: (result.archived ?? []).map((p) => relFromMemoriesRoot(p)),
					});
				} catch {
					// degrada — próximo syncIncremental reconcilia
				}
			}
			state.cachedIndexText = null; // invalida o índice do system prompt
			return { ok: true };
		} catch (err) {
			return { ok: false, error: (err as Error).message ?? String(err) };
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		state.projectId = identifyProject(ctx.cwd);
		ensureDirectories(state.projectId);

		const sessionFile = ctx.sessionManager.getSessionFile();
		state.currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();
		extractionModelRegistry = ctx.modelRegistry as unknown as ModelRegistryLike | null;

		// Índice SQLite/FTS5: abre + sync incremental (rebuild automático se
		// banco novo/schema antigo). Falha de índice não derruba a sessão —
		// memory_search cai no fallback rg.
		try {
			state.index = new MemoryIndex(INDEX_DB_PATH);
			state.index.open();
			state.index.syncIncremental(state.projectId);
		} catch (err) {
			// Fecha o índice antes de descartar — handle SQLite não pode vazar.
			try {
				state.index?.close();
			} catch {
				// close best-effort — estado já degradado
			}
			state.index = null;
			console.warn(`[pi-memory] índice indisponível: ${(err as Error).message} — busca via rg`);
		}

		// Pipeline operacional (episódios/evidências/jobs). Falha não derruba a
		// sessão — a captura de episódio vira no-op com log.
		try {
			pipeline = new PipelineDB(PIPELINE_DB_PATH);
			pipeline.open();
		} catch (err) {
			try {
				pipeline?.close();
			} catch {
				// close best-effort — estado já degradado
			}
			pipeline = null;
			console.warn(`[pi-memory] pipeline indisponível: ${(err as Error).message}`);
		}

		// Worker assíncrono com o processor de extração real. Recupera jobs
		// presos (crash/reload) e inicia o consumer do projeto atual. Falha
		// não derruba a sessão.
		try {
			if (pipeline) {
				pipeline.recoverStuckJobs();
				worker = new PipelineWorker(pipeline, {
					processor: createExtractionProcessor({
						getModel,
						getRelatedMemories,
						findExistingMemory,
						commitMemory,
					}),
					includeClaimed: true,
				});
				worker.setProject(state.projectId);
				worker.start();
			}
		} catch (err) {
			worker = null;
			console.warn(`[pi-memory] worker indisponível: ${(err as Error).message}`);
		}

		// Tools (Fase 6) consomem pipeline/worker via state
		state.pipeline = pipeline;
		state.worker = worker;

		state.consecutiveEmptySearches = 0;
		// Reseta o cache do índice de memória da sessão
		state.cachedIndexText = null;
	});

	pi.on("session_tree", async (_event, ctx) => {
		const nextProjectId = identifyProject(ctx.cwd);
		if (nextProjectId === state.projectId) {
			// Mesmo projeto — nada a trocar (worker/pipeline continuam).
			return;
		}
		state.projectId = nextProjectId;
		// Worker segue aberto entre projetos; passa a consumir o novo.
		worker?.setProject(nextProjectId);
		extractionModelRegistry = ctx.modelRegistry as unknown as ModelRegistryLike | null;

		// Sincroniza o índice para o novo projeto (global + projeto novo).
		// Falha no sync não derruba a sessão: fecha o índice (estado
		// potencialmente inconsistente com o disco) — memory_search cai no
		// fallback rg e o próximo session_start reconstrói.
		if (state.index?.isOpen) {
			try {
				state.index.syncIncremental(nextProjectId);
			} catch (err) {
				console.warn(
					`[pi-memory] índice não sincronizado p/ ${nextProjectId}: ${(err as Error).message} — busca via rg`,
				);
				try {
					state.index.close();
				} catch {
					// close em best-effort — estado já degradado
				}
				state.index = null;
			}
		}

		state.consecutiveEmptySearches = 0;
		// Reseta o cache do índice de memória da sessão
		state.cachedIndexText = null;
	});

	pi.on("before_agent_start", async (event) => {
		// Índice de memórias no SYSTEM PROMPT. Cache por sessão, invalidado em
		// escritas (memory_save/extract/decay).
		if (!state.projectId) return { systemPrompt: event.systemPrompt };
		if (state.cachedIndexText === null) {
			state.cachedIndexText = formatMemoryIndexText(listMemoryIndex(state.projectId));
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${state.cachedIndexText}` };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// agent_settled = fim real do prompt (após retries/compaction/followUps).
		// Captura o episódio no pipeline operacional — unidade semântica de
		// extração. Metadados apenas; nenhuma leitura de conteúdo aqui. Falha
		// nunca derruba o turno (best-effort).
		if (!state.projectId || !state.currentSessionHash) return;
		if (!pipeline?.isOpen) return;
		try {
			const sm = ctx.sessionManager;
			const branch = sm.getBranch();

			// Range do episódio: do último user prompt até a folha atual
			// (followUps e retries do mesmo prompt ficam dentro do episódio).
			let lastUserIdx = -1;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message?.role === "user") {
					lastUserIdx = i;
					break;
				}
			}
			if (lastUserIdx < 0) return; // sem prompt de usuário — nada a capturar

			const range = branch.slice(lastUserIdx);
			const leaf = branch[branch.length - 1];
			const fingerprint = buildEpisodeFingerprint(range.map((e) => e.id));

			// Dedup: agent_settled pode disparar mais de uma vez para o mesmo
			// episódio (harness) — a impressão digital cobre o range inteiro.
			if (pipeline.findEpisodeByFingerprint(state.currentSessionHash, fingerprint)) return;

			const episodeId = pipeline.insertEpisode({
				projectId: state.projectId,
				sessionId: state.currentSessionHash,
				sessionFile: sm.getSessionFile() ?? "",
				startEntryId: branch[lastUserIdx].id,
				endEntryId: leaf.id,
				leafId: sm.getLeafId() ?? leaf.id,
				fingerprint,
				tokenEstimate: estimateEpisodeTokens(range),
			});

			// Normaliza o episódio recém-capturado (determinístico, sem LLM —
			// só leitura do JSONL + classificação). Se a sessão ainda não foi
			// persistida no disco, normalizeEpisode mantém pending (retry).
			const captured = pipeline.getEpisode(episodeId);
			if (captured) {
				normalizeEpisode(pipeline, captured);
			}

			// Gatilho de job (tokens/episódios/sinal forte) + acorda o worker.
			// Assíncrono — o turno não espera o processamento.
			const trigger = maybeCreateJob(pipeline, state.projectId, { signalEpisodeId: episodeId });
			if (trigger.jobId) {
				worker?.wake();
			}
		} catch (err) {
			console.warn(`[pi-memory] captura de episódio falhou: ${(err as Error).message}`);
		}
	});

	pi.on("session_shutdown", async () => {
		state.index?.close();
		state.index = null;
		state.pipeline = null;
		state.worker = null;
		await worker?.stop();
		worker = null;
		pipeline?.close();
		pipeline = null;
	});

	registerMemoryStatus(pi, state);
	registerMemorySave(pi, state);
	registerMemorySearch(pi, state);
	registerMemoryDecay(pi, state);
	registerMemoryExtract(pi, state);
}
