/**
 * pi-memory — memory_retention tool (retenção por inatividade).
 *
 * Ações:
 * - `status`  — métricas atuais do .retention.sqlite (rastreadas, nunca
 *   usadas, protegidas, low retention, último sweep).
 * - `preview` — dry-run do sweep: calcula os scores que SERIAM aplicados
 *   agora, sem gravar nada. Usado para validar a política antes de ativar.
 * - `run`     — executa um sweep completo agora (reconcile → recompute →
 *   apply no índice).
 *
 * O módulo é controlado por feature flag (RETENTION_ENABLED): com o módulo
 * off, a tool responde com estado desativado — nenhuma escrita acontece.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRetentionScore, idleDays } from "../memory/retention.ts";
import { RetentionSchema, type RetentionAction } from "../schemas.ts";
import type { ToolState } from "./state.ts";

/** Preview em memória: como ficariam os scores sem gravar nada. */
function previewScores(
	records: { lastUsedAt: string | null; firstSeenAt: string; policy: string; retentionScore: number }[],
	now: Date,
): { wouldDecay: number; min: number; max: number; avg: number } {
	let wouldDecay = 0;
	let min = 1;
	let max = 0;
	let sum = 0;
	let n = 0;
	for (const r of records) {
		if (r.policy === "protected") continue;
		const score = computeRetentionScore(idleDays(now, r.lastUsedAt, r.firstSeenAt));
		if (score < r.retentionScore - 1e-9) wouldDecay++;
		min = Math.min(min, score);
		max = Math.max(max, score);
		sum += score;
		n++;
	}
	return { wouldDecay, min, max, avg: n > 0 ? Math.round((sum / n) * 1000) / 1000 : 0 };
}

export function registerMemoryRetention(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_retention",
		label: "Memory Retention",
		description:
			"Inactivity-based retention: status, dry-run preview or force run of the usage-decay sweep. " +
			"Memories are never moved to .supersedes/ nor lose confidence — only the operational retention_score changes (secondary ranking). " +
			"NATIVE pi tool — call memory_retention directly, NOT via mcp({ tool: 'memory_retention' }) or the mcp gateway.",
		promptSnippet:
			"memory_retention: status/preview/run do decay por inatividade",
		promptGuidelines: [
			"Use memory_retention preview para validar a política de decay por desuso antes de ativar o módulo.",
			"O decay por inatividade NÃO altera confidence nem move memórias para .supersedes/ — só reordena resultados de busca.",
		],
		parameters: RetentionSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const action: RetentionAction = params.action ?? "status";
			const store = state.retention;
			const scheduler = state.retentionScheduler;

			if (!store?.isOpen || !scheduler) {
				return {
					content: [
						{
							type: "text",
							text: "Retention disabled (feature flag RETENTION_ENABLED=false) or store unavailable.",
						},
					],
					details: { enabled: false, action },
				};
			}
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project", action },
				};
			}

			try {
				if (action === "run") {
					const result = await scheduler.sweep();
					const text = [
						"Sweep executed:",
						`  Reconcile: ${result.reconcile.added} added, ${result.reconcile.updated} updated, ${result.reconcile.deactivated} deactivated, ${result.reconcile.skipped} skipped`,
						`  Recompute: ${result.sweep.evaluated} evaluated, ${result.sweep.decayed} decayed, ${result.sweep.protectedCount} protected`,
						`  Applied: ${result.applied} scores in index`,
						`  Last sweep: ${result.sweep.lastSweepAt}`,
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: { enabled: true, action, sweep: result },
					};
				}

				if (action === "preview") {
					const records = store.listActiveRecords(state.projectId);
					const now = new Date();
					const p = previewScores(records, now);
					const m = store.getMetrics(state.projectId);
					const text = [
						"Retention preview (dry-run — nothing written):",
						`  Tracked: ${m.tracked} (never used ${m.neverUsed}, protected ${m.protectedCount}, low retention ${m.lowRetention})`,
						`  Would decay now: ${p.wouldDecay}`,
						`  Score range (normal): ${p.min.toFixed(3)}–${p.max.toFixed(3)} (avg ${p.avg.toFixed(3)})`,
						`  Last sweep: ${m.lastSweepAt ?? "(none)"}`,
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: { enabled: true, action, preview: p, metrics: m },
					};
				}

				// status
				const m = store.getMetrics(state.projectId);
				const text = [
					"Retention status:",
					`  Enabled: true (flag RETENTION_ENABLED)`,
					`  Tracked: ${m.tracked} (never used ${m.neverUsed}, protected ${m.protectedCount}, low retention ${m.lowRetention})`,
					`  Scheduler: ${scheduler.isRunning ? `running (interval 24h)` : "stopped"}`,
					`  Last sweep: ${m.lastSweepAt ?? "(none)"}`,
					`  DB: ${store.dbPath}`,
					"",
					"Call memory_retention preview for a dry-run of the next sweep, or run to force it.",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { enabled: true, action, metrics: m, db_path: store.dbPath },
				};
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				return {
					content: [{ type: "text", text: `Retention failed: ${msg}` }],
					details: { error: msg, action },
				};
			}
		},
	});
}
