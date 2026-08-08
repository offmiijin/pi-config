/**
 * pi-memory — Tests: índice SQLite/FTS5 (Fase 1: infra + rebuild).
 *
 * Usa root de memórias e banco temporários (mkdtemp) — nunca toca no
 * MEMORIES_ROOT real nem no .index.sqlite de produção.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { ensureFileDir } from "../session.ts";
import {
	MemoryIndex,
	SCHEMA_VERSION,
	cleanBody,
	hashContent,
	inferFromRelPath,
	listActiveMemoryFiles,
	readMemoryDocFromFile,
} from "../memory-index.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let tmpDbDir: string;
let projectA: string;
let projectB: string;

/** Escreve fixture em root; frontmatter = texto bruto entre `---`; retorna relPath. */
function writeFixture(root: string, relPath: string, fm: string, body: string): string {
	const abs = join(root, relPath);
	ensureFileDir(abs);
	writeFileSync(abs, `---\n${fm}---\n\n${body}`);
	return relPath;
}

function openProbe(dbPath: string): Database {
	return new Database(dbPath, { readonly: true });
}

function tableNames(dbPath: string): string[] {
	const probe = openProbe(dbPath);
	try {
		const rows = probe.query("SELECT name FROM sqlite_master").all() as { name: string }[];
		return rows.map((r) => r.name);
	} finally {
		probe.close();
	}
}

function docPaths(dbPath: string): string[] {
	const probe = openProbe(dbPath);
	try {
		const rows = probe.query("SELECT path FROM memory_documents").all() as { path: string }[];
		return rows.map((r) => r.path);
	} finally {
		probe.close();
	}
}

// ── inferFromRelPath ───────────────────────────────────────────────────────

describe("inferFromRelPath", () => {
	it("deriva global", () => {
		expect(inferFromRelPath("_global/gotchas/cache.md")).toEqual({
			scope: "global",
			projectId: null,
			type: "gotchas",
			context: "cache",
		});
	});

	it("deriva projeto", () => {
		expect(inferFromRelPath("projects/github_com_u_r/lessons/nextjs.md")).toEqual({
			scope: "project",
			projectId: "github_com_u_r",
			type: "lessons",
			context: "nextjs",
		});
	});

	it("lança para layout desconhecido", () => {
		expect(() => inferFromRelPath("foo.md")).toThrow(/não reconhecido/);
		expect(() => inferFromRelPath("projects/x/gotchas/y/z.md")).toThrow(/não reconhecido/);
	});
});

// ── readMemoryDocFromFile / cleanBody ──────────────────────────────────────

describe("readMemoryDocFromFile", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-doc-"));
		writeFixture(
			root,
			"_global/gotchas/exemplo.md",
			'context: exemplo\ntype: gotchas\nconfidence: 0.8\nupdated: 2026-08-01\nsummary: "Resumo curado"\ntags: ["cache", "invalidação"]\n',
			"## [2026-08-01 10:00:00] Título Antigo\n\nconteúdo antigo\n\n## [2026-08-07 10:00:00] Título Novo\nconfidence: 0.8\n\nO bug era no cache com acento e identificador_snake.\n",
		);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("normaliza metadados, título da última entrada e hash", () => {
		const doc = readMemoryDocFromFile(join(root, "_global/gotchas/exemplo.md"), "_global/gotchas/exemplo.md");
		expect(doc.scope).toBe("global");
		expect(doc.type).toBe("gotchas");
		expect(doc.context).toBe("exemplo");
		expect(doc.title).toBe("Título Novo");
		expect(doc.summary).toBe("Resumo curado");
		expect(doc.tags).toEqual(["cache", "invalidação"]);
		expect(doc.confidence).toBe(0.8);
		expect(doc.updated).toBe("2026-08-01");
		expect(doc.contentHash).toBe(hashContent(`---\ncontext: exemplo\ntype: gotchas\nconfidence: 0.8\nupdated: 2026-08-01\nsummary: "Resumo curado"\ntags: ["cache", "invalidação"]\n---\n\n## [2026-08-01 10:00:00] Título Antigo\n\nconteúdo antigo\n\n## [2026-08-07 10:00:00] Título Novo\nconfidence: 0.8\n\nO bug era no cache com acento e identificador_snake.\n`));
	});

	it("remove cabeçalhos de entrada e linhas confidence do corpo", () => {
		const doc = readMemoryDocFromFile(join(root, "_global/gotchas/exemplo.md"), "_global/gotchas/exemplo.md");
		expect(doc.body).not.toContain("## [");
		expect(doc.body).not.toContain("confidence:");
		expect(doc.body).not.toContain("Título"); // título vive na linha do header, removida
		expect(doc.body).toContain("conteúdo antigo");
		expect(doc.body).toContain("identificador_snake");
	});

	it("aplica defaults sem frontmatter", () => {
		const rel = "_global/lessons/sem-fm.md";
		const abs = join(root, rel);
		ensureFileDir(abs);
		writeFileSync(abs, "## [2026-08-02] Sem frontmatter\n\nconteúdo solto\n");
		const doc = readMemoryDocFromFile(abs, rel);
		expect(doc.confidence).toBe(0.5);
		expect(doc.summary).toBeNull();
		expect(doc.tags).toEqual([]);
		expect(doc.title).toBe("Sem frontmatter");
		expect(doc.updated).toBe("");
	});
});

describe("cleanBody", () => {
	it("colapsa linhas em branco excessivas", () => {
		expect(cleanBody("a\n\n\n\nb\n")).toBe("a\n\nb");
	});
});

// ── listActiveMemoryFiles ──────────────────────────────────────────────────

describe("listActiveMemoryFiles", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-lst-"));
		writeFixture(root, "_global/gotchas/g1.md", "type: gotchas\n", "x\n");
		writeFixture(root, "_global/_rules/g2.md", "type: _rules\n", "x\n");
		writeFixture(root, "projects/p1/gotchas/p1a.md", "type: gotchas\n", "x\n");
		writeFixture(root, "projects/p1/decisions/p1b.md", "type: decisions\n", "x\n");
		// Deve ser ignorado:
		writeFixture(root, "projects/p1/sessions/2026-08-02/h.md", "", "não é memória\n");
		writeFixture(root, ".supersedes/projects/p1/gotchas/velho.md", "", "superseded\n");
		writeFixture(root, "projects/p2/gotchas/p2a.md", "type: gotchas\n", "x\n");
		writeFixture(root, "_global/gotchas/ignorado.txt", "", "não md\n");
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("lista só .md ativos de global + projeto alvo, ordenado", () => {
		const files = listActiveMemoryFiles("p1", root);
		expect(files).toEqual([
			"_global/_rules/g2.md",
			"_global/gotchas/g1.md",
			"projects/p1/decisions/p1b.md",
			"projects/p1/gotchas/p1a.md",
		]);
	});

	it("não vaza arquivos de outro projeto", () => {
		const files = listActiveMemoryFiles("p1", root);
		expect(files.some((f) => f.includes("projects/p2"))).toBeFalse();
	});

	it("retorna vazio para root sem memórias", () => {
		const empty = mkdtempSync(join(tmpdir(), "pi-memory-empty-"));
		expect(listActiveMemoryFiles("p1", empty)).toEqual([]);
		rmSync(empty, { recursive: true, force: true });
	});
});

// ── MemoryIndex ────────────────────────────────────────────────────────────

describe("MemoryIndex", () => {
	let root: string;
	let dbPath: string;

	beforeAll(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-memory-idx-root-"));
		tmpDbDir = mkdtempSync(join(tmpdir(), "pi-memory-idx-db-"));
		root = tmpRoot;
		dbPath = join(tmpDbDir, "test.sqlite");
		projectA = `__test_idx_a_${Date.now()}`;
		projectB = `__test_idx_b_${Date.now()}`;

		// Global (2)
		writeFixture(root, "_global/gotchas/old-global.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-01-01\n", "## [2026-01-01 10:00:00] Global antiga\n\nconteúdo global antigo\n");
		writeFixture(root, "_global/_rules/new-global.md", "type: _rules\nconfidence: 0.9\nupdated: 2026-08-05\nsummary: \"Resumo global\"\n", "## [2026-08-05 10:00:00] Global nova\n\nconteúdo global novo\n");
		// Projeto A (2)
		writeFixture(root, `projects/${projectA}/lessons/proj-a.md`, "type: lessons\nconfidence: 0.7\nupdated: 2026-07-15\n", "## [2026-07-15 10:00:00] Lição A\n\nlição A sobre cache\n");
		writeFixture(root, `projects/${projectA}/gotchas/proj-b.md`, "type: gotchas\nconfidence: 0.5\nupdated: 2026-05-20\n", "## [2026-05-20 10:00:00] Gotcha B\n\n" + "y".repeat(300) + "\n");
		// Projeto B (1) — isolamento
		writeFixture(root, `projects/${projectB}/gotchas/leak-b.md`, "type: gotchas\nconfidence: 0.7\n", "## [2026-06-01] Leak B\n\nconteúdo exclusivo do projeto B\n");
		// Deve ser ignorado pelo rebuild
		writeFixture(root, `projects/${projectA}/sessions/2026-08-02/hash.md`, "", "observação de sessão\n");
		writeFixture(root, `.supersedes/projects/${projectA}/gotchas/velho.md`, "", "memória superseded\n");
	});

	afterAll(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		rmSync(tmpDbDir, { recursive: true, force: true });
	});

	it("open cria schema (memory_documents, memory_fts fts5, index_meta)", () => {
		const idx = new MemoryIndex(dbPath, root);
		idx.open();
		expect(idx.isOpen).toBeTrue();
		const names = tableNames(dbPath);
		expect(names).toContain("memory_documents");
		expect(names).toContain("memory_fts");
		expect(names).toContain("index_meta");
		idx.close();
		expect(idx.isOpen).toBeFalse();
	});

	it("banco novo marca needsRebuild", () => {
		const fresh = join(tmpDbDir, "fresh.sqlite");
		const idx = new MemoryIndex(fresh, root);
		idx.open();
		expect(idx.needsRebuild).toBeTrue();
		expect(idx.getMeta("schema_version")).toBeNull();
		idx.close();
	});

	it("banco e arquivos de log têm permissão 0o600", () => {
		const p = join(tmpDbDir, "perm.sqlite");
		const idx = new MemoryIndex(p, root);
		idx.open();
		idx.rebuild(projectA);
		expect(statSync(p).mode & 0o777).toBe(0o600);
		for (const suffix of ["-wal", "-shm"]) {
			const sp = p + suffix;
			if (existsSync(sp)) {
				expect(statSync(sp).mode & 0o777).toBe(0o600);
			}
		}
		idx.close();
	});

	it("rebuild indexa global + projeto alvo e ignora sessions/.supersedes", () => {
		const idx = new MemoryIndex(dbPath, root);
		idx.open();
		const stats = idx.rebuild(projectA);
		expect(stats.added).toBe(4); // 2 global + 2 projeto A
		expect(stats.removed).toBe(0);
		expect(stats.skipped).toBe(0);
		expect(idx.needsRebuild).toBeFalse();
		expect(idx.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));

		const paths = docPaths(dbPath);
		expect(paths).toHaveLength(4);
		expect(paths.some((p) => p.includes("sessions"))).toBeFalse();
		expect(paths.some((p) => p.includes(".supersedes"))).toBeFalse();

		// FTS recebe as mesmas 4 linhas (rowid = doc id)
		const probe = openProbe(dbPath);
		const n = probe.query("SELECT count(*) AS c FROM memory_fts").get() as { c: number };
		expect(Number(n.c)).toBe(4);
		probe.close();
		idx.close();
	});

	it("isola projetos: rebuild de A não indexa B; rebuild de B preserva A", () => {
		const idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(projectA);
		let paths = docPaths(dbPath);
		expect(paths.some((p) => p.includes(projectB))).toBeFalse();

		idx.rebuild(projectB);
		paths = docPaths(dbPath);
		// global (2) + A (2) + B (1) — B não removeu docs de A
		expect(paths).toHaveLength(5);
		expect(paths.some((p) => p.includes(projectA))).toBeTrue();
		expect(paths.some((p) => p.includes(projectB))).toBeTrue();
		idx.close();
	});

	it("rebuild remove stale (arquivo deletado do disco some do índice)", () => {
		// Banco fresco — isolado dos testes anteriores que populam o dbPath compartilhado
		const freshDb = join(tmpDbDir, "stale.sqlite");
		const idx = new MemoryIndex(freshDb, root);
		idx.open();
		idx.rebuild(projectA);
		expect(docPaths(freshDb)).toHaveLength(4);

		// Deleta um arquivo do projeto A e reconstrói
		rmSync(join(root, `projects/${projectA}/gotchas/proj-b.md`), { force: true });
		const stats = idx.rebuild(projectA);
		expect(stats.removed).toBe(4); // 2 global + 2 projeto A (inclui o deletado)
		expect(stats.added).toBe(3);
		const paths = docPaths(freshDb);
		expect(paths).toHaveLength(3);
		expect(paths.some((p) => p.includes("proj-b.md"))).toBeFalse();

		// Restaura para não afetar outros testes
		writeFixture(root, `projects/${projectA}/gotchas/proj-b.md`, "type: gotchas\nconfidence: 0.5\nupdated: 2026-05-20\n", "## [2026-05-20 10:00:00] Gotcha B\n\n" + "y".repeat(300) + "\n");
		idx.close();
	});

	it("arquivo sem frontmatter não derruba rebuild", () => {
		const idx = new MemoryIndex(dbPath, root);
		idx.open();
		const stats = idx.rebuild(projectA);
		expect(stats.skipped).toBe(0);
		idx.close();
	});

	it("versão de schema divergente marca needsRebuild no reopen", () => {
		const idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(projectA);
		expect(idx.needsRebuild).toBeFalse();

		// Corrompe a versão por fora
		const raw = new Database(dbPath);
		raw.query("UPDATE index_meta SET value = '999' WHERE key = 'schema_version'").run();
		raw.close();
		idx.close();

		const reopened = new MemoryIndex(dbPath, root);
		reopened.open();
		expect(reopened.needsRebuild).toBeTrue();
		reopened.rebuild(projectA);
		expect(reopened.needsRebuild).toBeFalse();
		reopened.close();
	});

	it("operações exigem open", () => {
		const idx = new MemoryIndex(dbPath, root);
		expect(idx.isOpen).toBeFalse();
		expect(() => idx.rebuild(projectA)).toThrow(/aberto/);
		expect(() => idx.getMeta("schema_version")).toThrow(/aberto/);
	});
});
