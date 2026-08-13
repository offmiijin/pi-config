/**
 * pi-memory — Tests: tool memory_status (Fase 6 — métricas do pipeline).
 *
 * Substitui o antigo contador de observações markdown pelas métricas reais
 * do pipeline: episódios por status, evidências, jobs, candidatos e worker.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	CANDIDATE_STATUS,
	EPISODE_STATUS,
	JOB_STATUS,
	PipelineDB,
	type NewCandidate,
	type NewEpisode,
} from "../pipeline/pipeline.ts";
import { registerMemoryStatus } from "../tools/status.ts";
import type { ToolState } from "../tools/state.ts";

interface ToolDef {
	execute: (
		...args: unknown[]
	) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

function captureTool(state: ToolState): ToolDef {
	let def: ToolDef | null = null;
	const fakePi = {
		registerTool: (d: ToolDef) => {
			def = d;
		},
	};
	registerMemoryStatus(fakePi as never, state);
	if (!def) throw new Error("registerTool não capturou a definição");
	return def;
}

function makeEpisode(projectId: string): NewEpisode {
	return {
		projectId,
		sessionId: `sess-${Math.random()}`,
		sessionFile: "/tmp/sess.jsonl",
		startEntryId: "a",
		endEntryId: "b",
		leafId: "b",
		fingerprint: `fp-${Math.random()}`,
		tokenEstimate: 100,
	};
}

let tmpDir: string;
let proj: string;
let pipeline: PipelineDB;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-tools-status-"));
	proj = "proj-status";
	pipeline = new PipelineDB(join(tmpDir, ".pipeline.sqlite"));
	pipeline.open();

	// Episódios em status variados
	const pendingId = pipeline.insertEpisode(makeEpisode(proj)); // pending
	pipeline.insertEpisode(makeEpisode(proj));
	pipeline.finalizeEpisode(pipeline.insertEpisode(makeEpisode(proj)), [], EPISODE_STATUS.NORMALIZED);
	pipeline.finalizeEpisode(pendingId, [], EPISODE_STATUS.PROCESSED);

	// Jobs: 1 done + 1 queued
	const doneJob = pipeline.createJob(proj, "tokens");
	pipeline.updateJob(doneJob, {
		status: JOB_STATUS.DONE,
		finishedAt: "2026-08-08T10:00:00Z",
		model: "opencode-go/deepseek-v4-flash",
		inputTokens: 1200,
		outputTokens: 350,
	});
	pipeline.createJob(proj, "episodes");

	// 1 candidato pending + 1 committed
	const cand: NewCandidate = {
		jobId: doneJob,
		action: "create",
		context: "ctx-status",
		type: "gotchas",
		scope: "project",
		title: "T",
		summary: "S",
		content: "C",
		confidence: 0.8,
		evidenceIds: [],
		supersedes: null,
		status: CANDIDATE_STATUS.PENDING,
	};
	pipeline.insertCandidates(doneJob, [
		cand,
		{ ...cand, context: "ctx-2", status: CANDIDATE_STATUS.COMMITTED },
	]);
});

afterAll(() => {
	pipeline.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_status (Fase 6)", () => {
	it("reporta métricas do pipeline (episódios, jobs, candidatos, última extração)", async () => {
		const state: ToolState = {
			projectId: proj,
			currentSessionHash: "",
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: null,
			pipeline,
			worker: null,
			retention: null,
			retentionScheduler: null,
		};
		const tool = captureTool(state);
		const res = await tool.execute("s1", {}, undefined, undefined, {});

		const details = res.details as Record<string, any>;
		expect(details.episodes.total).toBe(3);
		expect(details.episodes.pending).toBe(1);
		expect(details.episodes.normalized).toBe(1);
		expect(details.episodes.processed).toBe(1);
		expect(details.jobs.done).toBe(1);
		expect(details.jobs.queued).toBe(1);
		expect(details.candidates_pending).toBe(1);
		expect(details.last_extraction).toBeDefined();
		expect(details.last_extraction.model).toBe("opencode-go/deepseek-v4-flash");

		const text = res.content[0].text;
		expect(text).toContain("Pipeline status:");
		expect(text).toContain("Episodes:");
		expect(text).toContain("Last extraction:");
		expect(text).toContain("Candidate");
	});

	it("pipeline off → aviso explícito", async () => {
		const state: ToolState = {
			projectId: proj,
			currentSessionHash: "",
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: null,
			pipeline: null,
			worker: null,
			retention: null,
			retentionScheduler: null,
		};
		const tool = captureTool(state);
		const res = await tool.execute("s2", {}, undefined, undefined, {});
		expect(res.details!.pipeline).toBe("off");
		expect(res.content[0].text).toContain("indisponível");
	});

	it("erro sem projeto ativo", async () => {
		const state: ToolState = {
			projectId: "",
			currentSessionHash: "",
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: null,
			pipeline,
			worker: null,
			retention: null,
			retentionScheduler: null,
		};
		const tool = captureTool(state);
		const res = await tool.execute("s3", {}, undefined, undefined, {});
		expect(res.details!.error).toBe("no_active_project");
	});
});
