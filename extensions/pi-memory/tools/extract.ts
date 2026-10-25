/**
 * pi-memory — memory_extract tool (consolidação manual da sessão atual).
 *
 * Consolidação automática acontece em session_compact (imediato) e no
 * session_start seguinte ao fim de uma sessão (pendências). Esta tool força
 * a consolidação da SESSÃO ATUAL agora: normaliza pendings, divide os
 * episódios normalized em chunk jobs (reason "manual") e acorda o worker.
 * Retorna imediatamente — extração, validação e commit rodam em background.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EPISODE_STATUS, JOB_REASONS } from "../pipeline/pipeline.ts";
import { createSessionJobs } from "../pipeline/worker.ts";
import { normalizePendingEpisodes } from "../pipeline/evidence.ts";
import { ExtractSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

export function registerMemoryExtract(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_extract",
		label: "Memory Extract",
		description:
			"Queues background consolidation jobs for the CURRENT session: normalizes pending episodes, splits them into chunk jobs and wakes the worker. " +
			"Returns immediately with the job ids — extraction, validation and commit run in background. " +
			"Automatic consolidation runs on compaction and at the start of the next session; call when you want the current session consolidated now. " +
			"NATIVE pi tool — call memory_extract directly, NOT via mcp({ tool: 'memory_extract' }) or the mcp gateway.",
		promptSnippet: "memory_extract: Enqueue background consolidation of the current session",
		promptGuidelines: [
			"memory_extract enfileira jobs de consolidação da sessão atual e retorna imediatamente — a extração em background processa em chunks sequenciais.",
			"Use memory_extract quando quiser consolidar a sessão atual agora (a consolidação automática roda na compactação e no início da próxima sessão).",
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

			// 2. Chunk jobs da sessão atual (reason manual). Sem episódios
			//    normalized → nada a consolidar, não cria job vazio.
			let jobIds: string[] = [];
			if (state.currentSessionHash) {
				jobIds = createSessionJobs(
					state.pipeline,
					state.projectId,
					state.currentSessionHash,
					JOB_REASONS.MANUAL,
				);
			}
			if (jobIds.length > 0) state.worker?.wake();

			// 3. Status para o LLM.
			const pending = state.pipeline.countEpisodes(state.projectId, EPISODE_STATUS.PENDING);
			const workerRunning = state.worker?.isRunning ?? false;

			const text =
				jobIds.length > 0
					? `Consolidation queued for the current session (${jobIds.length} job(s), reason: manual).\n` +
						`Episodes pending: ${pending} | worker: ${workerRunning ? "running" : "off"}`
					: `Nothing to consolidate — no normalized episodes in the current session.\n` +
						`Episodes pending: ${pending} | worker: ${workerRunning ? "running" : "off"}`;

			return {
				content: [{ type: "text", text }],
				details: {
					job_id: jobIds[0] ?? null,
					job_ids: jobIds,
					reason: JOB_REASONS.MANUAL,
					closed_pending: closed,
					episodes_pending: pending,
					worker_running: workerRunning,
				},
			};
		},
	});
}
