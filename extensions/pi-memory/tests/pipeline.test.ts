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
import { DatabaseSync } from "node:sqlite";

import {
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

		const probe = new DatabaseSync(dbPath, { readOnly: true });
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

	it("migra banco v1 → v2 (colunas novas em jobs)", () => {
		const v1Path = join(tmpDir, "v1.sqlite");
		const raw = new DatabaseSync(v1Path);
		raw.exec(`
			CREATE TABLE jobs (
			  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, reason TEXT NOT NULL,
			  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
			  prompt_version INTEGER, model TEXT, reasoning_level TEXT,
			  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
			  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
			  error TEXT
			);
			CREATE TABLE pipeline_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			INSERT INTO pipeline_meta (key, value) VALUES ('schema_version', '1');
		`);
		raw.close();

		const p = new PipelineDB(v1Path);
		p.open();
		const probe = new DatabaseSync(v1Path, { readOnly: true });
		try {
			const cols = probe.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
			const names = cols.map((c) => c.name);
			expect(names).toContain("next_attempt_at");
			expect(names).toContain("details");
			const version = probe
				.prepare("SELECT value FROM pipeline_meta WHERE key = 'schema_version'")
				.get() as { value: string };
			expect(version.value).toBe("2");
		} finally {
			probe.close();
		}
		p.close();
	});
});
