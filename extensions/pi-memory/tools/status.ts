/**
 * pi-memory — memory_status tool (Fase 6: métricas do pipeline).
 *
 * Substitui o antigo contador de observações markdown (threshold 50) pelas
 * métricas reais do pipeline: episódios por status, evidências, jobs,
 * última extração e candidatos pendentes de revisão.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CANDIDATE_STATUS,
	EPISODE_STATUS,
	JOB_STATUS,
} from "../pipeline.ts";
import { StatusSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

export function registerMemoryStatus(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Shows the background extraction pipeline status: episodes per status, evidence, jobs, last extraction and pending candidates. " +
			"Call periodically to check extraction progress. " +
			"NATIVE pi tool — call memory_status directly, NOT via mcp({ tool: 'memory_status' }) or the mcp gateway.",
		promptSnippet: "memory_status: Check extraction pipeline status",
		promptGuidelines: [
			"memory_status mostra métricas do pipeline de extração em background (episódios, evidências, jobs, candidatos) — use para acompanhar o progresso.",
		],
		parameters: StatusSchema,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}
			const p = state.pipeline;
			if (!p?.isOpen) {
				return {
					content: [{ type: "text", text: "Pipeline indisponível — extração desligada." }],
					details: { pipeline: "off" },
				};
			}

			const countE = (s: string) => p.countEpisodes(state.projectId, s as never);
			const episodes = {
				pending: countE(EPISODE_STATUS.PENDING),
				normalized: countE(EPISODE_STATUS.NORMALIZED),
				selected: countE(EPISODE_STATUS.SELECTED),
				processed: countE(EPISODE_STATUS.PROCESSED),
				ignored: countE(EPISODE_STATUS.IGNORED),
				failed: countE(EPISODE_STATUS.FAILED),
				total: p.countEpisodes(state.projectId),
			};
			const evidenceCount = p.countEvidence();
			const elig = p.aggregatePendingEpisodes(state.projectId);
			const jobs = {
				queued: p.countJobs(state.projectId, JOB_STATUS.QUEUED),
				processing: p.countJobs(state.projectId, JOB_STATUS.PROCESSING),
				retry: p.countJobs(state.projectId, JOB_STATUS.RETRY),
				done: p.countJobs(state.projectId, JOB_STATUS.DONE),
				dead_letter: p.countJobs(state.projectId, JOB_STATUS.DEAD_LETTER),
			};
			const pendingCandidates = p.countCandidatesByProject(
				state.projectId,
				CANDIDATE_STATUS.PENDING,
			);
			const lastExtraction = p.listJobs(state.projectId, JOB_STATUS.DONE, 1)[0] ?? null;

			const text = [
				"Pipeline status:",
				`  Episodes: ${episodes.total} (pending ${episodes.pending}, normalized ${episodes.normalized}, selected ${episodes.selected}, processed ${episodes.processed}, ignored ${episodes.ignored}, failed ${episodes.failed})`,
				`  Evidence: ${evidenceCount} fragments, ~${elig.tokens} tokens eligible (${elig.count} episodes)`,
				`  Jobs: ${jobs.queued} queued, ${jobs.processing} processing, ${jobs.retry} retry, ${jobs.done} done, ${jobs.dead_letter} dead_letter`,
				lastExtraction
					? `  Last extraction: ${lastExtraction.finishedAt} (${lastExtraction.inputTokens} in / ${lastExtraction.outputTokens} out tokens, ${lastExtraction.model ?? "?"})`
					: "  Last extraction: (none yet)",
				`  Candidates pending review: ${pendingCandidates}`,
				`  Worker: ${state.worker?.isRunning ? `running (job ${state.worker.currentJobId ?? "-"})` : "off"}`,
				"",
				"Call memory_extract to force a background extraction job.",
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					episodes,
					evidence_count: evidenceCount,
					eligible_tokens: elig.tokens,
					jobs,
					candidates_pending: pendingCandidates,
					worker_running: state.worker?.isRunning ?? false,
					last_extraction: lastExtraction
						? {
								job_id: lastExtraction.id,
								finished_at: lastExtraction.finishedAt,
								input_tokens: lastExtraction.inputTokens,
								output_tokens: lastExtraction.outputTokens,
								model: lastExtraction.model,
							}
						: null,
				},
			};
		},
	});
}
