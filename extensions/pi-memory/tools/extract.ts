/**
 * pi-memory — memory_extract tool (Fase 6: enfileirador assíncrono).
 *
 * O pipeline legado (extração síncrona de observações markdown) foi
 * substituído pelo worker em background: esta tool apenas
 * 1. fecha episódios pendentes (normalização adiada — sessão não persistida
 *    no settle),
 * 2. cria um job forçado (reason "manual"),
 * 3. acorda o worker e retorna imediatamente com o job id + status.
 *
 * A extração (prompt → modelo → validação → revisor → commit) roda no
 * worker sem bloquear o agente.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EPISODE_STATUS } from "../pipeline.ts";
import { maybeCreateJob } from "../worker.ts";
import { normalizePendingEpisodes } from "../evidence.ts";
import { ExtractSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

export function registerMemoryExtract(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_extract",
		label: "Memory Extract",
		description:
			"Queues a background extraction job: normalizes pending episodes, creates a job (force) and wakes the worker. " +
			"Returns immediately with the job id — extraction, validation and commit run in background. " +
			"Call when you want extraction now instead of waiting for automatic triggers. " +
			"NATIVE pi tool — call memory_extract directly, NOT via mcp({ tool: 'memory_extract' }) or the mcp gateway.",
		promptSnippet: "memory_extract: Enqueue background extraction job",
		promptGuidelines: [
			"memory_extract enfileira um job de extração assíncrono e retorna imediatamente com o job id — a extração em background processa episódios automaticamente.",
			"Use memory_extract quando quiser forçar a extração agora (em vez de esperar os gatilhos automáticos de tokens/episódios).",
		],
		parameters: ExtractSchema,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}
			if (!state.pipeline?.isOpen) {
				return {
					content: [{ type: "text", text: "Error: pipeline operacional indisponível" }],
					details: { error: "pipeline_unavailable" },
				};
			}

			// 1. Fecha episódios pendentes (a sessão pode não ter sido
			//    persistida quando agent_settled disparou).
			const { normalized: closed } = normalizePendingEpisodes(
				state.pipeline,
				state.projectId,
			);

			// 2. Job forçado + acorda o worker (assíncrono — não aguardado).
			const trigger = maybeCreateJob(state.pipeline, state.projectId, { force: true });
			if (trigger.jobId) state.worker?.wake();

			// 3. Status para o LLM.
			const pending = state.pipeline.countEpisodes(state.projectId, EPISODE_STATUS.PENDING);
			const elig = state.pipeline.aggregatePendingEpisodes(state.projectId);
			const workerRunning = state.worker?.isRunning ?? false;

			const text = trigger.jobId
				? `Extraction job queued (job: ${trigger.jobId}, reason: ${trigger.reason}).\n` +
					`Episodes pending: ${pending} | eligible: ${elig.count} (${elig.tokens} tokens) | worker: ${workerRunning ? "running" : "off"}`
				: `No job created (inconsistent state — active job exists and force failed).\n` +
					`Episodes pending: ${pending} | eligible: ${elig.count} (${elig.tokens} tokens) | worker: ${workerRunning ? "running" : "off"}`;

			return {
				content: [{ type: "text", text }],
				details: {
					job_id: trigger.jobId,
					reason: trigger.reason,
					closed_pending: closed,
					episodes_pending: pending,
					eligible_episodes: elig.count,
					eligible_tokens: elig.tokens,
					worker_running: workerRunning,
				},
			};
		},
	});
}
