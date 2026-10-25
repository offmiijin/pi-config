/**
 * pi-memory — Tests: tool memory_extract (consolidação manual da sessão).
 *
 * A tool normaliza pendings e cria chunk jobs da SESSÃO ATUAL
 * (reason manual). Usa PipelineDB + PipelineWorker reais sobre diretório
 * temporário.
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EPISODE_STATUS, JOB_REASONS, JOB_STATUS, PipelineDB } from "../pipeline/pipeline.ts";
import { PipelineWorker } from "../pipeline/worker.ts";
import { registerMemoryExtract } from "../tools/extract.ts";
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
	registerMemoryExtract(fakePi as never, state);
	if (!def) throw new Error("registerTool não capturou a definição");
	return def;
}

function sessionLine(entry: Record<string, unknown>): string {
	return JSON.stringify(entry) + "\n";
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("timeout esperando condição");
		await new Promise((r) => setTimeout(r, 10));
	}
}

let tmpDir: string;
let proj: string;
let pipeline: PipelineDB;

function makeState(worker: PipelineWorker | null = null, sessionHash = "sess-h"): ToolState {
	return {
		projectId: proj,
		currentSessionHash: sessionHash,
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
		index: null,
		retention: null,
		retentionScheduler: null,
		pipeline,
		worker,
	};
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-tools-extract-"));
	proj = "proj-extract";
	pipeline = new PipelineDB(join(tmpDir, ".pipeline.sqlite"));
	pipeline.open();
});

afterAll(() => {
	pipeline.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_extract (manual — sessão atual)", () => {
	it("sem episódios normalized → nenhum job", async () => {
		const tool = captureTool(makeState(null, `sess-empty-${Math.random()}`));
		const res = await tool.execute("id1", {}, undefined, undefined, {});

		expect(res.details!.job_id).toBeNull();
		expect(res.details!.job_ids).toEqual([]);
		expect(res.content[0].text).toContain("Nothing to consolidate");
		expect(pipeline.countJobs(proj, JOB_STATUS.QUEUED)).toBe(0);
	});

	it("com episódio normalized da sessão atual → chunk job manual", async () => {
		const sess = `s-manual-${Math.random()}`;
		const epId = pipeline.insertEpisode({
			projectId: proj,
			sessionId: sess,
			sessionFile: "/tmp/nonexistent-sess.jsonl",
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-manual-${Math.random()}`,
			tokenEstimate: 10,
		});
		pipeline.finalizeEpisode(epId, [], EPISODE_STATUS.NORMALIZED);

		const tool = captureTool(makeState(null, sess));
		const res = await tool.execute("id1b", {}, undefined, undefined, {});

		expect((res.details!.job_ids as string[]).length).toBe(1);
		expect(res.details!.reason).toBe(JOB_REASONS.MANUAL);
		expect(res.content[0].text).toContain("Consolidation queued");
	});

	it("não consolida episódios de outra sessão", async () => {
		const sessA = `s-other-a-${Math.random()}`;
		const sessB = `s-other-b-${Math.random()}`;
		const epId = pipeline.insertEpisode({
			projectId: proj,
			sessionId: sessA,
			sessionFile: "/tmp/nonexistent-sess.jsonl",
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-other-${Math.random()}`,
			tokenEstimate: 10,
		});
		pipeline.finalizeEpisode(epId, [], EPISODE_STATUS.NORMALIZED);

		const tool = captureTool(makeState(null, sessB));
		const res = await tool.execute("id1c", {}, undefined, undefined, {});

		expect(res.details!.job_ids).toEqual([]);
		expect(pipeline.getEpisode(epId)!.status).toBe(EPISODE_STATUS.NORMALIZED);
	});

	it("normaliza episódios pending com sessão persistida", async () => {
		const sessionFile = join(tmpDir, "sess-close.jsonl");
		writeFileSync(
			sessionFile,
			sessionLine({ type: "session", version: 3, id: "s", cwd: "/tmp" }) +
				sessionLine({ type: "message", id: "a", parentId: null, message: { role: "user", content: "faça algo" } }) +
				sessionLine({
					type: "message",
					id: "b",
					parentId: "a",
					message: { role: "assistant", content: [{ type: "text", text: "feito" }] },
				}),
		);
		const sess = "s-close";
		const epId = pipeline.insertEpisode({
			projectId: proj,
			sessionId: sess,
			sessionFile,
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-${Math.random()}`,
			tokenEstimate: 10,
		});
		expect(pipeline.getEpisode(epId)!.status).toBe(EPISODE_STATUS.PENDING);

		const tool = captureTool(makeState(null, sess));
		const res = await tool.execute("id2", {}, undefined, undefined, {});

		expect((res.details!.closed_pending as number)).toBeGreaterThanOrEqual(1);
		// Normalizado e imediatamente reivindicado pelo chunk job manual.
		expect(pipeline.getEpisode(epId)!.status).toBe(EPISODE_STATUS.SELECTED);
		expect((res.details!.job_ids as string[]).length).toBe(1);
	});

	it("acorda o worker — job manual processado em background", async () => {
		const sess = `s-bg-${Math.random()}`;
		const epId = pipeline.insertEpisode({
			projectId: proj,
			sessionId: sess,
			sessionFile: "/tmp/nonexistent-sess.jsonl",
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-bg-${Math.random()}`,
			tokenEstimate: 10,
		});
		pipeline.finalizeEpisode(epId, [], EPISODE_STATUS.NORMALIZED);

		const worker = new PipelineWorker(pipeline); // processor padrão: selectionOnly
		worker.setProject(proj);
		worker.start();

		const tool = captureTool(makeState(worker, sess));
		const res = await tool.execute("id3", {}, undefined, undefined, {});
		const jobId = res.details!.job_id as string;

		await waitFor(() => pipeline.getJob(jobId)?.status === JOB_STATUS.DONE);
		await worker.stop();
	});

	it("erro sem projeto ativo", async () => {
		const tool = captureTool({ ...makeState(), projectId: "" });
		const res = await tool.execute("id4", {}, undefined, undefined, {});
		expect(res.details!.error).toBe("no_active_project");
	});
});
