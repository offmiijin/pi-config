/**
 * pi-memory — memory_status tool (métricas do pipeline).
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
	PENDING_SESSION_STATUS,
} from "../pipeline/pipeline.ts";
import { StatusSchema } from "../schemas.ts";
import type { MemoryModelConfig, ModelProcessorSource } from "../memory/config.ts";
import type { ToolState } from "./state.ts";

// ── Relatório estilo doctor (/doctor) ─────────────────────────────
// Espelha pi-doctor/buildReportText: header + checks com ícones +
// resumo + footnote. Mantém formatPipelineStatus (legado) intacto.

export type MemoryCheckStatus = "ok" | "info" | "warn" | "error";

export interface MemoryCheck {
	id: string;
	label: string;
	status: MemoryCheckStatus;
	detail?: string;
	fix?: string;
}

const MEMORY_STATUS_ICON: Record<MemoryCheckStatus, string> = {
	ok: "✅",
	info: "ℹ️",
	warn: "⚠️",
	error: "❌",
};

/**
 * Formata ISO UTC (ex.: 2026-10-25T20:41:53.784Z) no horário local do
 * sistema (ex.: 25/10/2026, 17:41:53). O banco grava em UTC via
 * toISOString(); exibir o cru parecia "3h adiantado" para quem está em -03.
 * Falha de parse devolve o original (nunca quebra o relatório).
 */
export function formatLocalTimestamp(iso: string | null | undefined): string {
	if (!iso) return "(none yet)";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
};

export function formatPipelineStatus(state: ToolState): string {
	if (!state.projectId) {
		return "Pipeline status: sem projeto ativo.";
	}
	const p = state.pipeline;
	if (!p?.isOpen) {
		return "Pipeline status: indisponível — extração desligada.";
	}

	const countE = (s: string) => p.countEpisodes(state.projectId, s as never);
	const episodes = {
		pending: countE(EPISODE_STATUS.PENDING),
		normalized: countE(EPISODE_STATUS.NORMALIZED),
		selected: countE(EPISODE_STATUS.SELECTED),
		processed: countE(EPISODE_STATUS.PROCESSED),
		ignored: countE(EPISODE_STATUS.IGNORED),
		total: p.countEpisodes(state.projectId),
	};
	const evidenceCount = p.countEvidence({ projectId: state.projectId });
	const elig = p.aggregateNormalizedEpisodes(state.projectId);
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
	const pendingSessions = p.countPendingSessions(
		state.projectId,
		PENDING_SESSION_STATUS.PENDING,
	);
	const lastExtraction = p.listJobs(state.projectId, JOB_STATUS.DONE, 1)[0] ?? null;

	let retText = "";
	if (state.retention?.isOpen) {
		const m = state.retention.getMetrics(state.projectId);
		retText = `  Retention: ${m.tracked} tracked (never used ${m.neverUsed}, protected ${m.protectedCount}, low ${m.lowRetention}), last sweep ${m.lastSweepAt ? formatLocalTimestamp(m.lastSweepAt) : "(none)"}`;
	}

	return [
		"Pipeline status:",
		`  Episodes: ${episodes.total} (pending ${episodes.pending}, normalized ${episodes.normalized}, selected ${episodes.selected}, processed ${episodes.processed}, ignored ${episodes.ignored})`,
		`  Evidence: ${evidenceCount} fragments, ~${elig.tokens} tokens eligible (${elig.count} episodes)`,
		`  Jobs: ${jobs.queued} queued, ${jobs.processing} processing, ${jobs.retry} retry, ${jobs.done} done, ${jobs.dead_letter} dead_letter`,
		lastExtraction
			? `  Last extraction: ${formatLocalTimestamp(lastExtraction.finishedAt)} (${lastExtraction.inputTokens} in / ${lastExtraction.outputTokens} out tokens, ${lastExtraction.model ?? "?"})`
			: "  Last extraction: (none yet)",
		`  Candidates pending review: ${pendingCandidates}`,
		`  Sessions pending consolidation: ${pendingSessions}`,
		`  Worker: ${state.worker?.isRunning ? `running (job ${state.worker.currentJobId ?? "-"})` : "off"}`,
		...(retText ? [retText] : []),
	].join("\n");
}

/**
 * Monta os checks do relatório estilo doctor a partir do estado da sessão.
 * Mesma semântica do pi-doctor/runChecks: cada check tem id/label/status/
 * detail e fix opcional. Status: error = bloqueia extração, warn = degrada
 * ou pede ação, info = métrica, ok = saudável.
 */
export function buildMemoryChecks(
	state: ToolState,
	model: MemoryModelConfig | null,
	source: ModelProcessorSource,
): MemoryCheck[] {
	const sourceLabel =
		source === "override"
			? "override (/memory config)"
			: source === "settings"
				? "settings.json (defaultModel)"
				: "nenhum disponível";
	const checks: MemoryCheck[] = [
		{
			id: "model-processor",
			label: "Model processor",
			status: model ? "ok" : "warn",
			detail: model ? `${model.provider}/${model.id} [${sourceLabel}]` : `— [${sourceLabel}]`,
			fix: model ? undefined : "/memory config para selecionar um modelo autenticado",
		},
		{
			id: "auth",
			label: "Autenticação",
			status: "info",
			detail: "reutiliza as credenciais configuradas no Pi",
		},
	];

	if (!state.projectId) {
		checks.push({
			id: "pipeline",
			label: "Pipeline de extração",
			status: "error",
			detail: "sem projeto ativo",
			fix: "abra uma sessão com cwd de projeto válido",
		});
		return checks;
	}

	const p = state.pipeline;
	if (!p?.isOpen) {
		checks.push({
			id: "pipeline",
			label: "Pipeline de extração",
			status: "error",
			detail: "indisponível — extração desligada",
			fix: "reinicie a sessão; se persistir, verifique o banco do pipeline",
		});
		return checks;
	}

	checks.push({
		id: "pipeline",
		label: "Pipeline de extração",
		status: "ok",
		detail: "aberto",
	});

	checks.push({
		id: "index",
		label: "Índice de busca",
		status: state.index?.isOpen ? "ok" : "warn",
		detail: state.index?.isOpen ? "SQLite FTS5 sincronizado" : "indisponível — busca via rg",
		fix: state.index?.isOpen ? undefined : "reinicie a sessão para reconstruir o índice",
	});

	const countE = (s: string) => p.countEpisodes(state.projectId, s as never);
	const episodes = {
		pending: countE(EPISODE_STATUS.PENDING),
		normalized: countE(EPISODE_STATUS.NORMALIZED),
		selected: countE(EPISODE_STATUS.SELECTED),
		processed: countE(EPISODE_STATUS.PROCESSED),
		ignored: countE(EPISODE_STATUS.IGNORED),
		total: p.countEpisodes(state.projectId),
	};
	checks.push({
		id: "episodes",
		label: "Episódios",
		status: "info",
		detail:
			`${episodes.total} total ` +
			`(pending ${episodes.pending}, normalized ${episodes.normalized}, ` +
			`selected ${episodes.selected}, processed ${episodes.processed}, ignored ${episodes.ignored})`,
	});

	const evidenceCount = p.countEvidence({ projectId: state.projectId });
	const elig = p.aggregateNormalizedEpisodes(state.projectId);
	checks.push({
		id: "evidence",
		label: "Evidências",
		status: "info",
		detail: `${evidenceCount} fragments, ~${elig.tokens} tokens eligible (${elig.count} episodes)`,
	});

	const jobs = {
		queued: p.countJobs(state.projectId, JOB_STATUS.QUEUED),
		processing: p.countJobs(state.projectId, JOB_STATUS.PROCESSING),
		retry: p.countJobs(state.projectId, JOB_STATUS.RETRY),
		done: p.countJobs(state.projectId, JOB_STATUS.DONE),
		dead_letter: p.countJobs(state.projectId, JOB_STATUS.DEAD_LETTER),
	};
	checks.push({
		id: "jobs",
		label: "Jobs de extração",
		status: jobs.dead_letter > 0 ? "warn" : "ok",
		detail:
			`${jobs.queued} queued, ${jobs.processing} processing, ${jobs.retry} retry, ` +
			`${jobs.done} done, ${jobs.dead_letter} dead_letter`,
		fix: jobs.dead_letter > 0 ? "investigue os jobs em dead_letter (logs do worker)" : undefined,
	});

	const lastExtraction = p.listJobs(state.projectId, JOB_STATUS.DONE, 1)[0] ?? null;
	checks.push({
		id: "last-extraction",
		label: "Última extração",
		status: "info",
		detail: lastExtraction
			? `${formatLocalTimestamp(lastExtraction.finishedAt)} (${lastExtraction.inputTokens} in / ${lastExtraction.outputTokens} out tokens, ${lastExtraction.model ?? "?"})`
			: "(none yet)",
	});

	const pendingCandidates = p.countCandidatesByProject(state.projectId, CANDIDATE_STATUS.PENDING);
	checks.push({
		id: "candidates",
		label: "Candidatos pendentes",
		status: pendingCandidates > 0 ? "warn" : "info",
		detail: `${pendingCandidates} aguardando revisão`,
		fix: pendingCandidates > 0 ? "aguarde o worker ou rode memory_extract" : undefined,
	});

	const pendingSessions = p.countPendingSessions(state.projectId, PENDING_SESSION_STATUS.PENDING);
	checks.push({
		id: "sessions",
		label: "Sessões pendentes",
		status: pendingSessions > 0 ? "warn" : "info",
		detail: `${pendingSessions} aguardando consolidação`,
		fix: pendingSessions > 0 ? "serão consolidadas no próximo session_start ou via memory_extract" : undefined,
	});

	const running = state.worker?.isRunning ?? false;
	checks.push({
		id: "worker",
		label: "Worker",
		status: running ? "ok" : "info",
		detail: running ? `running (job ${state.worker?.currentJobId ?? "-"})` : "off",
	});

	if (state.retention?.isOpen) {
		const m = state.retention.getMetrics(state.projectId);
		checks.push({
			id: "retention",
			label: "Retenção por desuso",
			status: "info",
			detail:
			`${m.tracked} tracked (never used ${m.neverUsed}, protected ${m.protectedCount}, ` +
			`low ${m.lowRetention}), last sweep ${m.lastSweepAt ? formatLocalTimestamp(m.lastSweepAt) : "(none)"}`,
		});
	} else {
		checks.push({
			id: "retention",
			label: "Retenção por desuso",
			status: "info",
			detail: "desativada (flag off)",
		});
	}

	return checks;
}

/**
 * Texto do relatório estilo doctor: header + checks + resumo + footnote.
 * Espelha pi-doctor/buildReportText (ícones, "Fix:" e contagem).
 */
export function buildMemoryReportText(checks: MemoryCheck[], projectId?: string): string {
	const header = [
		"🧠 Pi Memory — diagnóstico da memória persistente",
		`Projeto: ${projectId || "desconhecido"}`,
		"",
	];
	const body = checks.map((c) => {
		const line = `${MEMORY_STATUS_ICON[c.status]} ${c.label}: ${c.detail ?? ""}`;
		return c.fix ? `${line}\n   Fix: ${c.fix}` : line;
	});
	const counts = checks.reduce<Record<MemoryCheckStatus, number>>(
		(acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
		{ ok: 0, info: 0, warn: 0, error: 0 },
	);
	const summary = `Resumo: ${counts.ok} ok · ${counts.info} info · ${counts.warn} aviso(s) · ${counts.error} pendência(s)`;
	const footnote = counts.error > 0 ? `\nApós corrigir, reinicie a sessão ou rode /memory config.` : "";
	return [...header, ...body, "", summary, footnote].join("\n");
}

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
				total: p.countEpisodes(state.projectId),
			};
			const evidenceCount = p.countEvidence({ projectId: state.projectId });
			const elig = p.aggregateNormalizedEpisodes(state.projectId);
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
			const pendingSessions = p.countPendingSessions(
				state.projectId,
				PENDING_SESSION_STATUS.PENDING,
			);
			const lastExtraction = p.listJobs(state.projectId, JOB_STATUS.DONE, 1)[0] ?? null;

			// Seção de retenção por inatividade (feature flag) — omitida quando off.
			let retDetails: Record<string, unknown> | null = null;
			if (state.retention?.isOpen) {
				const m = state.retention.getMetrics(state.projectId);
				retDetails = {
					tracked: m.tracked,
					never_used: m.neverUsed,
					protected: m.protectedCount,
					low_retention: m.lowRetention,
					last_sweep_at: m.lastSweepAt,
				};
			}

			const text = [
				formatPipelineStatus(state),
				"",
				"Call memory_extract to consolidate the current session now.",
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					episodes,
					evidence_count: evidenceCount,
					eligible_tokens: elig.tokens,
					jobs,
					candidates_pending: pendingCandidates,
					sessions_pending: pendingSessions,
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
					...(retDetails ? { retention: retDetails } : {}),
				},
			};
		},
	});
}
