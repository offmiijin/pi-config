/**
 * pi-memory — Tests: tool memory_extract (Fase 6 — enfileirador assíncrono).
 *
 * A extração síncrona legada foi substituída: a tool agora normaliza
 * episódios pendentes, cria um job forçado (reason manual) e acorda o worker,
 * retornando imediatamente. Usa PipelineDB + PipelineWorker reais sobre
 * diretório temporário.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EPISODE_STATUS, JOB_STATUS, PipelineDB } from "../pipeline/pipeline.ts";
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

function makeState(worker: PipelineWorker | null = null): ToolState {
	return {
		projectId: proj,
		currentSessionHash: "sess-h",
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
		index: null,
		retention: null,
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

describe("memory_extract (Fase 6 — async)", () => {
	it("sem episódios elegíveis → não cria job vazio", async () => {
		const tool = captureTool(makeState());
		const res = await tool.execute("id1", {}, undefined, undefined, {});

		expect(res.details!.job_id).toBeNull();
		expect(res.content[0].text).toContain("Nothing to extract");
		expect(pipeline.countJobs(proj, JOB_STATUS.QUEUED)).toBe(0);
	});

	it("com episódio elegível → enfileira job forçado", async () => {
		const epId = pipeline.insertEpisode({
			projectId: proj,
			sessionId: "s-forced",
			sessionFile: "/tmp/nonexistent-sess.jsonl",
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-forced-${Math.random()}`,
			tokenEstimate: 10,
		});
		pipeline.finalizeEpisode(epId, [], EPISODE_STATUS.NORMALIZED);

		const tool = captureTool(makeState());
		const res = await tool.execute("id1b", {}, undefined, undefined, {});

		expect(res.details!.job_id).toBeDefined();
		expect(res.details!.reason).toBe("manual");
		expect(res.content[0].text).toContain("Extraction job queued");
		expect(pipeline.countJobs(proj, JOB_STATUS.QUEUED)).toBeGreaterThanOrEqual(1);
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
		const epId = pipeline.insertEpisode({
			projectId: proj,
			sessionId: "s-close",
			sessionFile,
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-${Math.random()}`,
			tokenEstimate: 10,
		});
		expect(pipeline.getEpisode(epId)!.status).toBe(EPISODE_STATUS.PENDING);

		const tool = captureTool(makeState());
		const res = await tool.execute("id2", {}, undefined, undefined, {});

		expect((res.details!.closed_pending as number)).toBeGreaterThanOrEqual(1);
		expect(pipeline.getEpisode(epId)!.status).toBe(EPISODE_STATUS.NORMALIZED);
	});

	it("acorda o worker — job processado em background (done + episódios selected)", async () => {
		const worker = new PipelineWorker(pipeline); // processor padrão: selectionOnly
		worker.setProject(proj);
		worker.start();

		const tool = captureTool(makeState(worker));
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
