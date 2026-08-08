/**
 * pi-memory — Extensão de memória para o agente PI.
 *
 * Gerencia memórias persistentes (rules, decisions, gotchas, lessons,
 * patterns) nos escopos global e por projeto. Memórias são arquivos markdown
 * ricos agrupados por contexto, buscáveis via índice SQLite FTS5/BM25
 * (fallback ripgrep).
 *
 * O LLM conduz todas as operações de memória via tools. A extensão captura
 * episódios (agent_settled → pipeline.sqlite) para extração em background;
 * observações markdown legadas ficam atrás de ENABLE_LEGACY_OBSERVATIONS.
 *
 * Layout:
 *   index.ts            — estado da extensão + event handlers (wiring)
 *   constants.ts        — constantes compartilhadas + setup de projeto
 *   db.ts               — driver SQLite compartilhado (node/bun)
 *   pipeline.ts         — pipeline operacional (episódios, evidências, jobs)
 *   session.ts          — ciclo de vida das observações de sessão (legado)
 *   memory.ts           — CRUD de arquivos de memória + índice + save
 *   memory-search.ts    — fallback de busca via ripgrep (índice indisponível)
 *   memory-extract.ts   — helpers de extração assistida por LLM (legado)
 *   schemas.ts          — schemas de parâmetros das tools
 *   tools/*.ts          — um arquivo por tool (status, save, search, decay, extract)
 */

import { appendFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ENABLE_LEGACY_OBSERVATIONS,
	OBSERVATION_THRESHOLD,
	ensureDirectories,
	identifyProject,
} from "./constants.ts";
import {
	buildTurnFingerprint,
	countObservations,
	createTurnDedupState,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	extractToolCalls,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	getSessionFilePath,
	hashSessionFile,
	nextTurnDedup,
	SAVE_REMINDER_COOLDOWN,
	shouldPromptExtraction,
	shouldRemindSave,
	type ToolObservation,
} from "./session.ts";
import { formatMemoryIndexText, listMemoryIndex } from "./memory.ts";
import { INDEX_DB_PATH, MemoryIndex } from "./memory-index.ts";
import {
	PIPELINE_DB_PATH,
	PipelineDB,
	buildEpisodeFingerprint,
	estimateEpisodeTokens,
} from "./pipeline.ts";
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
		lastPromptedBucket: -1,
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
		index: null,
	};

	// Estado do gatilho de extração automática (usado só pelos event handlers)
	let extractionDueCount = 0;
	// Estado do lembrete de save (turns que mudam código)
	let saveReminderDue = false;
	let lastSaveReminderObs = 0;
	// Flag: lembrete enviado neste user turn (máx 1x por turn —
	// turn_end pode disparar várias vezes no mesmo turn com edits)
	let saveReminderSent = false;
	// Dedup de turn (o harness pode disparar turn_end duas vezes para o mesmo turn)
	let turnDedupState = createTurnDedupState();
	// Buffer de resultados de tools do turn atual (toolCallId → observation)
	const toolResultsBuffer = new Map<string, ToolObservation>();
	// Pipeline operacional (episódios → worker de extração futuro). Null se
	// indisponível — captura de episódio vira no-op com log.
	let pipeline: PipelineDB | null = null;

	pi.on("tool_result", async (event) => {
		const e = event as unknown as {
			toolCallId?: string;
			toolName?: string;
			content?: unknown;
			isError?: boolean;
		};
		if (!e.toolCallId) return;
		// O buffer só alimenta o pipeline legado de observações (turn_end).
		if (!ENABLE_LEGACY_OBSERVATIONS) return;
		toolResultsBuffer.set(e.toolCallId, {
			name: e.toolName ?? "unknown",
			result: extractTextContent(e.content),
			isError: !!e.isError,
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		state.projectId = identifyProject(ctx.cwd);
		ensureDirectories(state.projectId);

		const sessionFile = ctx.sessionManager.getSessionFile();
		state.currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();

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

		state.lastPromptedBucket = -1;
		extractionDueCount = 0;
		state.consecutiveEmptySearches = 0;
		saveReminderDue = false;
		lastSaveReminderObs = 0;
		saveReminderSent = false;
		// Reseta o cache do índice de memória da sessão
		state.cachedIndexText = null;
		turnDedupState = createTurnDedupState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		const nextProjectId = identifyProject(ctx.cwd);
		if (nextProjectId === state.projectId) {
			// Mesmo projeto: NÃO reseta o estado do gatilho. Resetar lastPromptedBucket
			// aqui, com um followUp de extração pendente (nextTurn), faria o gatilho
			// re-disparar o mesmo bucket → mensagem duplicada no próximo user prompt.
			return;
		}
		state.projectId = nextProjectId;

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

		state.lastPromptedBucket = -1;
		extractionDueCount = 0;
		state.consecutiveEmptySearches = 0;
		saveReminderDue = false;
		lastSaveReminderObs = 0;
		saveReminderSent = false;
		// Reseta o cache do índice de memória da sessão
		state.cachedIndexText = null;
		turnDedupState = createTurnDedupState();
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!state.projectId || !state.currentSessionHash) return;

		const assistantMsg = event.message;
		if (!assistantMsg) return;

		const agentResponse = extractTextContent(assistantMsg.content);

		// O harness pode disparar turn_end mais de uma vez para o MESMO turn
		// (observado em sessões com followUps: obs duplicadas, contagem inflada,
		// lembretes/gatilhos re-disparados). Dedup por event.turnIndex (índice
		// único por turn); fallback para a impressão digital do conteúdo quando
		// turnIndex não existe.
		const fingerprint = buildTurnFingerprint(assistantMsg.content);
		const turnIndex = (event as { turnIndex?: number }).turnIndex;
		const { skip, state: nextState } = nextTurnDedup(turnIndex, fingerprint, turnDedupState);
		turnDedupState = nextState;
		if (skip) return;

		// Fase 0: observações markdown legadas desativadas — a captura migrou
		// para episódios no pipeline operacional (agent_settled). O código
		// permanece atrás da flag durante a transição (removido na Fase 6).
		if (!ENABLE_LEGACY_OBSERVATIONS) return;

		const branch = ctx.sessionManager.getBranch();

		// Encontra o último user prompt e coleta os resultados de tools do turn
		// atual (mensagens role="toolResult" após o último prompt)
		let userPrompt = "";
		let lastUserIdx = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "user") {
				lastUserIdx = i;
				userPrompt = extractTextContent(entry.message.content);
				break;
			}
		}

		// Tool calls do conteúdo do assistente (ordem de origem)
		const toolCalls = extractToolCalls(assistantMsg.content);

		// Resultados deste turn vindos do branch (mensagens role="toolResult" após
		// o último user — também em ordem de origem, como documentado)
		const branchResults: ToolObservation[] = [];
		if (lastUserIdx >= 0) {
			for (let i = lastUserIdx + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message?.role === "toolResult") {
					branchResults.push({
						name: entry.message.toolName ?? "unknown",
						result: extractTextContent(entry.message.content),
						isError: !!entry.message.isError,
					});
				}
			}
		}

		// Alinha toolCalls[i] ↔ branchResults[i]; o buffer enriquece por id
		let toolResults: ToolObservation[];
		if (toolCalls.length > 0) {
			toolResults = toolCalls.map((tc, i) => {
				const buffered = toolResultsBuffer.get(tc.id);
				if (buffered && buffered.result) return buffered;
				return branchResults[i] ?? { name: tc.name };
			});
		} else {
			// Sem blocos toolCall no conteúdo: usa branchResults direto
			toolResults =
				branchResults.length > 0
					? branchResults
					: extractToolCallNames(assistantMsg.content).map((n) => ({ name: n }));
		}
		toolResultsBuffer.clear();

		const sessionFile = getSessionFilePath(state.projectId, state.currentSessionHash);
		ensureFileDir(sessionFile);

		if (!existsSync(sessionFile)) {
			const header = formatSessionHeader(state.currentSessionHash);
			appendFileSync(sessionFile, header + "\n");
		}

		const obsNumber = countObservations(sessionFile) + 1;
		const obs = formatObservation(obsNumber, userPrompt, toolResults, agentResponse);
		appendFileSync(sessionFile, obs + "\n");

		// Envia mensagem ao LLM em cada cruzamento de threshold (50, 100, ...).
		// Entregue via "nextTurn" (não followUp): sem atraso intra-turn, sem
		// ciclo extra. lastPromptedBucket (monotônico) já garante 1x/threshold;
		// não é resetado em before_agent_start nem em session_tree para o mesmo
		// projeto (evita re-disparar o mesmo bucket com mensagem pendente).
		const count = countObservations(sessionFile);
		const { prompt, bucket } = shouldPromptExtraction(count, state.lastPromptedBucket);
		if (prompt) {
			state.lastPromptedBucket = bucket;
			try {
				pi.sendUserMessage(
					`[pi-memory] Session reached ${count} observations (threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					{ deliverAs: "nextTurn" },
				);
			} catch {
				// Fallback: injeta no próximo before_agent_start
				extractionDueCount = count;
			}
		}

		// Turn mudou código e passou o cooldown → lembra o LLM de salvar
		// aprendizado durável direto via memory_save (sem esperar o extract).
		// Máx 1x por USER turn: a guarda saveReminderSent é resetada em
		// agent_settled (fim real do prompt) — NÃO em before_agent_start, que
		// também dispara para ciclos gerados pela extensão e resetaria a guarda
		// no meio do turn (lembretes duplicados).
		// Entregue via "nextTurn": não interrompe nem adiciona ciclo extra — a
		// mensagem chega no próximo user prompt, sem atraso dentro do turn e
		// sem re-disparo pelo followUp.
		if (
			!saveReminderSent &&
			shouldRemindSave(
				toolResults.map((t) => t.name),
				obsNumber,
				lastSaveReminderObs,
				SAVE_REMINDER_COOLDOWN,
			)
		) {
			saveReminderSent = true;
			lastSaveReminderObs = obsNumber;
			try {
				pi.sendUserMessage(
					"[pi-memory] This turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
				{ deliverAs: "nextTurn" },
				);
			} catch {
				saveReminderDue = true;
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// NOTA: NÃO resete saveReminderSent aqui. before_agent_start também
		// dispara para ciclos gerados pela extensão (sendUserMessage), que
		// resetavam a guarda no meio do turn e permitiam lembretes duplicados.
		// O reset acontece em agent_settled (fim real do user prompt).

		// Índice de memórias no SYSTEM PROMPT (reconstruído por turn — não polui
		// o histórico como a mensagem customType fazia). Cache por sessão,
		// invalidado em escritas (memory_save/extract/decay).
		const withIndex = (prompt: string): string => {
			if (!state.projectId) return prompt;
			if (state.cachedIndexText === null) {
				state.cachedIndexText = formatMemoryIndexText(listMemoryIndex(state.projectId));
			}
			return `${prompt}\n\n${state.cachedIndexText}`;
		};

		if (extractionDueCount > 0) {
			const count = extractionDueCount;
			extractionDueCount = 0;
			return {
				systemPrompt: withIndex(event.systemPrompt),
				message: {
					customType: "pi-memory",
					content:
						`[pi-memory] Session reached ${count} observations ` +
						`(threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					display: true,
				},
			};
		}
		if (saveReminderDue) {
			saveReminderDue = false;
			return {
				systemPrompt: withIndex(event.systemPrompt),
				message: {
					customType: "pi-memory",
					content:
						"[pi-memory] A recent turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
					display: true,
				},
			};
		}

		return { systemPrompt: withIndex(event.systemPrompt) };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// agent_settled = fim real do prompt (após retries/compaction/followUps).
		// Resetar a guarda aqui (não em before_agent_start) garante no máximo 1
		// lembrete por USER turn, mesmo com turns longos de tools.
		saveReminderSent = false;

		// Fase 0: captura do episódio no pipeline operacional. agent_settled é o
		// fechamento real do prompt — unidade semântica de extração (o antigo
		// turn_end fragmentava por turn). Metadados apenas; nenhuma leitura de
		// conteúdo aqui. Falha nunca derruba o turno (best-effort).
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

			pipeline.insertEpisode({
				projectId: state.projectId,
				sessionId: state.currentSessionHash,
				sessionFile: sm.getSessionFile() ?? "",
				startEntryId: branch[lastUserIdx].id,
				endEntryId: leaf.id,
				leafId: sm.getLeafId() ?? leaf.id,
				fingerprint,
				tokenEstimate: estimateEpisodeTokens(range),
			});
		} catch (err) {
			console.warn(`[pi-memory] captura de episódio falhou: ${(err as Error).message}`);
		}
	});

	pi.on("session_shutdown", async () => {
		state.index?.close();
		state.index = null;
		pipeline?.close();
		pipeline = null;
	});

	registerMemoryStatus(pi, state);
	registerMemorySave(pi, state);
	registerMemorySearch(pi, state);
	registerMemoryDecay(pi, state);
	registerMemoryExtract(pi, state);
}
