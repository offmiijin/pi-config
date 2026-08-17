/**
 * pi-memory — Tests: integração de retenção no índice FTS (schema v3).
 *
 * Cobre: updateRetentionScores, preservação do score em upsert (conteúdo
 * atualizado não zera score), ordenação com retention_score como critério
 * secundário e migração v2→v3 (coluna adicionada por ALTER).
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DatabaseCtor } from "../db.ts";
import { ensureFileDir } from "../session.ts";
import { MemoryIndex, SCHEMA_VERSION, readMemoryDocFromFile } from "../memory/memory-index.ts";

let root: string;
let dbDir: string;

function writeMem(rel: string, fm: string, body: string): string {
	const abs = join(root, rel);
	ensureFileDir(abs);
	writeFileSync(abs, `---\n${fm}---\n\n${body}`);
	return rel;
}

function memRel(context: string, extraFm = ""): string {
	const rel = `_global/gotchas/${context}.md`;
	writeMem(
		rel,
		`context: ${context}\ntype: gotchas\nscope: global\nrevision: 1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\nconfidence: 0.8\nmemory_id: "mem-${context}"\n${extraFm}`,
		`# ${context}\n\nConteúdo de ${context}.`,
	);
	return rel;
}

describe("MemoryIndex — retenção (schema v3)", () => {
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "ret-idx-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "ret-idx-db-"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("SCHEMA_VERSION é 3 (coluna retention_score presente)", () => {
		expect(SCHEMA_VERSION).toBe(3);
	});

	it("updateRetentionScores aplica scores e upsert de conteúdo preserva", () => {
		const rel = memRel("cache");
		const idx = new MemoryIndex(join(dbDir, "i1.sqlite"), root);
		idx.open();
		idx.rebuild("p1");

		idx.updateRetentionScores(new Map([[rel, 0.25]]));
		let r = idx.search({ terms: ["cache"], scope: "global" })[0];
		expect(r.retentionScore).toBeCloseTo(0.25, 3);

		// Conteúdo atualizado (mesmo path) — o score NÃO pode zerar.
		const doc = readMemoryDocFromFile(join(root, rel), rel);
		idx.upsertDocument({ ...doc, body: "Conteúdo atualizado de cache.", title: "cache2" });
		r = idx.search({ terms: ["cache"], scope: "global" })[0];
		expect(r.retentionScore).toBeCloseTo(0.25, 3);

		idx.close();
	});

	it("ordenação usa retention_score como critério secundário (após confidence)", () => {
		const idx = new MemoryIndex(join(dbDir, "i2.sqlite"), root);
		idx.open();
		idx.rebuild("p1");

		// Dois docs com a MESMA relevância/confiança: score menor fica depois.
		memRel("alpha");
		memRel("beta");
		idx.syncIncremental("p1");
		idx.updateRetentionScores(new Map([["_global/gotchas/alpha.md", 0.1]]));

		// Termo comum aos dois corpos (tokenizer remove acentos).
		const res = idx.search({ terms: ["conteudo"], scope: "global", limit: 10 });
		expect(res.length).toBeGreaterThanOrEqual(2);
		const alphaIdx = res.findIndex((r) => r.context === "alpha");
		const betaIdx = res.findIndex((r) => r.context === "beta");
		expect(betaIdx).toBeLessThan(alphaIdx); // beta (score 1.0) antes de alpha (0.1)
		expect(res.find((r) => r.context === "alpha")?.retentionScore).toBeCloseTo(0.1, 3);

		idx.close();
	});

	it("migração v2→v3 adiciona a coluna via ALTER (idempotente)", () => {
		// Simula banco v2: cria sem retention_score e com schema_version=2.
		const v2Path = join(dbDir, "v2.sqlite");
		{
			const db = new DatabaseCtor(v2Path);
			db.exec(
				"CREATE TABLE memory_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, project_id TEXT, type TEXT NOT NULL, context TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, tags_json TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL, updated TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL)",
			);
			db.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			db.exec("INSERT INTO index_meta (key, value) VALUES ('schema_version', '2')");
			db.close();
		}
		const idx = new MemoryIndex(v2Path, root);
		idx.open(); // dispara migrateSchema(2) → ALTER ADD COLUMN
		const probe = new DatabaseCtor(v2Path);
		try {
			const cols = (
				probe.prepare("PRAGMA table_info(memory_documents)").all() as { name: string }[]
			).map((c) => c.name);
			expect(cols).toContain("retention_score");
			expect(cols).toContain("memory_id");
		} finally {
			probe.close();
		}
		expect(idx.isOpen).toBe(true);
		idx.close();
	});
});
