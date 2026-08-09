/**
 * pi-memory — Tests: pipeline operacional (pipeline.sqlite + episódios).
 *
 * Usa banco temporário (mkdtemp) — nunca toca no .pipeline.sqlite de produção.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DatabaseCtor } from "../db.ts";
import {
	EPISODE_STATUS,
	PipelineDB,
	buildEpisodeFingerprint,
	estimateEntryTokens,
	estimateEpisodeTokens,
	type EpisodeEntryLike,
} from "../pipeline.ts";

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-pipeline-"));
	dbPath = join(tmpDir, ".pipeline.sqlite");
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildEpisodeFingerprint", () => {
	it("é determinística", () => {
		const ids = ["a1", "b2", "c3"];
		expect(buildEpisodeFingerprint(ids)).toBe(buildEpisodeFingerprint(ids));
	});

	it("muda com a ordem dos ids", () => {
		expect(buildEpisodeFingerprint(["a1", "b2"])).not.toBe(
			buildEpisodeFingerprint(["b2", "a1"]),
		);
	});

	it("retorna hash de 16 chars", () => {
		expect(buildEpisodeFingerprint(["a1", "b2"]).length).toBe(16);
	});
});

describe("estimateEntryTokens", () => {
	it("conta texto de string", () => {
		const entry: EpisodeEntryLike = {
			type: "message",
			id: "x",
			message: { role: "user", content: "abcd" },
		};
		expect(estimateEntryTokens(entry)).toBe(1);
	});

	it("conta blocos text + toolCall arguments", () => {
		const entry: EpisodeEntryLike = {
			type: "message",
			id: "x",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "toolCall", name: "edit", id: "t1", arguments: { path: "a.ts" } },
				],
			},
		};
		// "hello" = 5 chars → 2; JSON de args = 15 chars → 4 → total 6
		expect(estimateEntryTokens(entry)).toBe(6);
	});

	it("conta command + output de bashExecution", () => {
		const entry: EpisodeEntryLike = {
			type: "message",
			id: "x",
			message: { role: "bashExecution", command: "npm test", output: "ok" },
		};
		// "npm test" = 8 chars → 2; "ok" = 2 chars → 1 → total 3
		expect(estimateEntryTokens(entry)).toBe(3);
	});

	it("conta summary (compaction/branch)", () => {
		const entry: EpisodeEntryLike = { type: "compaction", id: "x", summary: "resumo" };
		// "resumo" = 6 chars → ceil(6/4) = 2
		expect(estimateEntryTokens(entry)).toBe(2);
	});

	it("ignora conteúdo não textual (image)", () => {
		const entry: EpisodeEntryLike = {
			type: "message",
			id: "x",
			message: {
				role: "assistant",
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			},
		};
		expect(estimateEntryTokens(entry)).toBe(0);
	});

	it("ignora toolCall sem arguments", () => {
		const entry: EpisodeEntryLike = {
			type: "message",
			id: "x",
			message: { role: "assistant", content: [{ type: "toolCall", name: "ls" }] },
		};
		// JSON.stringify(undefined ?? {}) = "{}" → 2 chars → 1
		expect(estimateEntryTokens(entry)).toBe(1);
	});
});

describe("estimateEpisodeTokens", () => {
	it("soma entradas", () => {
		const entries: EpisodeEntryLike[] = [
			{
				type: "message",
				id: "a",
				message: { role: "user", content: "quatro quatro quatro!" },
			},
			{
				type: "message",
				id: "b",
				message: { role: "assistant", content: [{ type: "text", text: "ola" }] },
			},
		];
		// 21 chars → ceil(21/4) = 6; "ola" = 3 chars → 1 → total 7
		expect(estimateEpisodeTokens(entries)).toBe(7);
	});
});

describe("PipelineDB", () => {
	it("abre e cria schema (tabelas do pipeline)", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		expect(p.isOpen).toBeTrue();
		p.close();
		expect(p.isOpen).toBeFalse();

		const probe = new DatabaseCtor(dbPath);
		try {
			const rows = probe
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as { name: string }[];
			const names = rows.map((r) => r.name);
			for (const t of ["episodes", "evidence", "jobs", "candidates", "pipeline_meta"]) {
				expect(names).toContain(t);
			}
		} finally {
			probe.close();
		}
	});

	it("insertEpisode + countEpisodes + dedup por fingerprint", () => {
		const p = new PipelineDB(dbPath);
		p.open();

		const ep = {
			projectId: "proj-a",
			sessionId: "sess-1",
			sessionFile: "/tmp/sess.jsonl",
			startEntryId: "a",
			endEntryId: "c",
			leafId: "c",
			fingerprint: "fp-1",
			tokenEstimate: 42,
		};

		const id = p.insertEpisode(ep);
		expect(id.startsWith("ep_")).toBeTrue();
		expect(p.countEpisodes()).toBe(1);
		expect(p.countEpisodes("proj-a")).toBe(1);
		expect(p.countEpisodes("proj-b")).toBe(0);
		expect(p.countEpisodes("proj-a", "pending")).toBe(1);
		expect(p.countEpisodes("proj-a", "processed")).toBe(0);

		const found = p.findEpisodeByFingerprint("sess-1", "fp-1");
		expect(found).toBeDefined();
		expect(found!.projectId).toBe("proj-a");
		expect(found!.sessionFile).toBe("/tmp/sess.jsonl");
		expect(found!.tokenEstimate).toBe(42);
		expect(found!.status).toBe("pending");
		expect(found!.startEntryId).toBe("a");
		expect(found!.endEntryId).toBe("c");
		expect(found!.leafId).toBe("c");

		// Mesmo fingerprint na mesma sessão → índice único rejeita
		expect(() => p.insertEpisode({ ...ep })).toThrow("UNIQUE");

		// Sessão diferente, mesmo fingerprint → ok
		p.insertEpisode({ ...ep, sessionId: "sess-2" });
		expect(p.countEpisodes()).toBe(2);
		p.close();
	});

	it("reabre sem perder dados e open é idempotente", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		p.open(); // no-op
		const before = p.countEpisodes();
		p.close();

		const p2 = new PipelineDB(dbPath);
		p2.open();
		expect(p2.countEpisodes()).toBe(before);
		p2.close();
	});

	it("operações sem open lançam erro claro", () => {
		const p = new PipelineDB(join(tmpDir, "closed.sqlite"));
		expect(() => p.countEpisodes()).toThrow("PipelineDB não está aberto");
	});

	it("insertCandidates com lista vazia remove candidatos de tentativa anterior", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		const jobId = p.createJob("proj-ic", "tokens");
		p.insertCandidates(jobId, [
			{
				jobId,
				action: "create",
				context: "ctx-ic",
				type: "gotchas",
				scope: "project",
				title: "T",
				summary: "S",
				content: "C",
				confidence: 0.8,
				evidenceIds: [],
				supersedes: null,
				status: "pending",
			},
		]);
		expect(p.countCandidates(jobId)).toBe(1);
		// Retry com resposta sem memórias: candidatos anteriores do MESMO job
		// não podem permanecer (seriam reprocessados).
		p.insertCandidates(jobId, []);
		expect(p.countCandidates(jobId)).toBe(0);
		p.close();
	});

	it("countEvidence filtra por projeto (join com episodes)", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		const ep = (projectId: string, sessionId: string) => ({
			projectId,
			sessionId,
			sessionFile: "/tmp/sess.jsonl",
			startEntryId: "a",
			endEntryId: "b",
			leafId: "b",
			fingerprint: `fp-${sessionId}`,
			tokenEstimate: 42,
		});
		const epA = p.insertEpisode(ep("proj-ev-a", "sess-a"));
		const epB = p.insertEpisode(ep("proj-ev-b", "sess-b"));
		p.finalizeEpisode(epA, [
			{
				episodeId: epA,
				kind: "correction",
				payloadJson: JSON.stringify({ text: "a1" }),
				contentHash: "h-a1",
				tokenEstimate: 5,
				redactionFlags: 0,
				isError: 0,
				priority: 1,
			},
		], EPISODE_STATUS.NORMALIZED);
		p.finalizeEpisode(epB, [
			{
				episodeId: epB,
				kind: "correction",
				payloadJson: JSON.stringify({ text: "b1" }),
				contentHash: "h-b1",
				tokenEstimate: 5,
				redactionFlags: 0,
				isError: 0,
				priority: 1,
			},
			{
				episodeId: epB,
				kind: "command",
				payloadJson: JSON.stringify({ text: "b2" }),
				contentHash: "h-b2",
				tokenEstimate: 5,
				redactionFlags: 0,
				isError: 0,
				priority: 1,
			},
		], EPISODE_STATUS.NORMALIZED);
		expect(p.countEvidence({ projectId: "proj-ev-a" })).toBe(1);
		expect(p.countEvidence({ projectId: "proj-ev-b" })).toBe(2);
		expect(p.countEvidence()).toBe(3); // sem filtro — total geral
		expect(p.countEvidence({ episodeId: epB })).toBe(2);
		p.close();
	});

	it("recoverJobsWithPendingCandidates requeue jobs done com pending", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		const jobWithPending = p.createJob("proj-rpc", "tokens");
		p.insertCandidates(jobWithPending, [
			{
				jobId: jobWithPending,
				action: "create",
				context: "ctx-rpc-pend",
				type: "gotchas",
				scope: "project",
				title: "T",
				summary: "S",
				content: "C",
				confidence: 0.8,
				evidenceIds: [],
				supersedes: null,
				status: "pending",
			},
		]);
		// Simula o estado órfão legado: job já finalizado com candidato pending.
		const doneProbe = new DatabaseCtor(dbPath);
		try {
			doneProbe
				.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?")
				.run(new Date().toISOString(), jobWithPending);
		} finally {
			doneProbe.close();
		}

		// Job done sem pendings NÃO é tocado.
		const cleanJob = p.createJob("proj-rpc", "tokens");
		p.insertCandidates(cleanJob, [
			{
				jobId: cleanJob,
				action: "create",
				context: "ctx-rpc-clean",
				type: "gotchas",
				scope: "project",
				title: "T",
				summary: "S",
				content: "C",
				confidence: 0.8,
				evidenceIds: [],
				supersedes: null,
				status: "committed",
			},
		]);
		const doneProbe2 = new DatabaseCtor(dbPath);
		try {
			doneProbe2
				.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?")
				.run(new Date().toISOString(), cleanJob);
		} finally {
			doneProbe2.close();
		}

		expect(p.recoverJobsWithPendingCandidates()).toBe(1);
		expect(p.getJob(jobWithPending)!.status).toBe("queued");
		expect(p.getJob(jobWithPending)!.error).toContain("pending");
		expect(p.getJob(cleanJob)!.status).toBe("done"); // não tocado
		p.close();
	});
});
