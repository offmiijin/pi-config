/**
 * pi-memory — Tests: índice SQLite/FTS5.
 *
 * Usa root de memórias e banco temporários (mkdtemp) — nunca toca no
 * MEMORIES_ROOT real nem no .index.sqlite de produção.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { ensureFileDir } from "../session.ts";
import {
	MemoryIndex,
	SCHEMA_VERSION,
	buildFtsQuery,
	cleanBody,
	hashContent,
	inferFromRelPath,
	listActiveMemoryFiles,
	normalizeForSearch,
	readMemoryDocFromFile,
} from "../memory-index.ts";
import type { IndexDocument } from "../memory-index.ts";

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

function openProbe(dbPath: string): DatabaseSync {
	return new DatabaseSync(dbPath, { readOnly: true });
}

function tableNames(dbPath: string): string[] {
	const probe = openProbe(dbPath);
	try {
		const rows = probe.prepare("SELECT name FROM sqlite_master").all() as { name: string }[];
		return rows.map((r) => r.name);
	} finally {
		probe.close();
	}
}

function docPaths(dbPath: string): string[] {
	const probe = openProbe(dbPath);
	try {
		const rows = probe.prepare("SELECT path FROM memory_documents").all() as { path: string }[];
		return rows.map((r) => r.path);
	} finally {
		probe.close();
	}
}

/** Escreve fixture e devolve o doc normalizado (fluxo real save → upsert). */
function docFromFixture(root: string, rel: string, fm: string, body: string): IndexDocument {
	writeFixture(root, rel, fm, body);
	return readMemoryDocFromFile(join(root, rel), rel);
}

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

	it("lê formato v2 (snapshot): título de `# ` e corpo sem o título", () => {
		writeFixture(
			root,
			"_global/gotchas/snapshot.md",
			'context: snapshot\ntype: gotchas\nscope: global\nrevision: 3\nconfidence: 0.9\nupdated: 2026-08-08\nsummary: "Resumo snapshot"\nevidence: ["ev_1", "ev_2"]\n',
			"# Título do Snapshot\n\nconteúdo consolidado do snapshot.\n",
		);
		const doc = readMemoryDocFromFile(
			join(root, "_global/gotchas/snapshot.md"),
			"_global/gotchas/snapshot.md",
		);
		expect(doc.title).toBe("Título do Snapshot");
		expect(doc.body).toBe("conteúdo consolidado do snapshot.");
		expect(doc.body).not.toContain("Título do Snapshot");
		expect(doc.summary).toBe("Resumo snapshot");
		expect(doc.confidence).toBe(0.9);
	});
});

describe("cleanBody", () => {
	it("colapsa linhas em branco excessivas", () => {
		expect(cleanBody("a\n\n\n\nb\n")).toBe("a\n\nb");
	});
});

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
		const n = probe.prepare("SELECT count(*) AS c FROM memory_fts").get() as { c: number };
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

	it("schema divergente (v1) migra no reopen: FTS recriado com norm + reindex do markdown", () => {
		const idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(projectA);
		expect(idx.needsRebuild).toBeFalse();

		// Simula banco v1: FTS sem coluna norm + versão antiga.
		const raw = new DatabaseSync(dbPath);
		raw.exec("DROP TABLE memory_fts");
		raw.exec(
			`CREATE VIRTUAL TABLE memory_fts USING fts5(title, summary, tags, body, ` +
				`tokenize = "unicode61 remove_diacritics 2 tokenchars '_'")`,
		);
		raw
			.prepare("UPDATE index_meta SET value = '1' WHERE key = 'schema_version'")
			.run();
		raw.close();
		idx.close();

		const reopened = new MemoryIndex(dbPath, root);
		reopened.open(); // migra v1 → v2
		expect(reopened.needsRebuild).toBeFalse();
		expect(reopened.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));

		// FTS recriado com coluna norm
		const probe = openProbe(dbPath);
		const cols = probe.prepare("PRAGMA table_info(memory_fts)").all() as { name: string }[];
		expect(cols.map((c) => c.name)).toContain("norm");
		probe.close();

		// Reindexado a partir do markdown — busca continua funcionando
		expect(
			reopened.search({ terms: ["cache"], projectId: projectA }).length,
		).toBeGreaterThanOrEqual(1);
		reopened.close();
	});

	it("operações exigem open", () => {
		const idx = new MemoryIndex(dbPath, root);
		expect(idx.isOpen).toBeFalse();
		expect(() => idx.rebuild(projectA)).toThrow(/aberto/);
		expect(() => idx.getMeta("schema_version")).toThrow(/aberto/);
	});
});

describe("buildFtsQuery", () => {
	it("envolve cada termo em frase com prefixo (OR entre termos)", () => {
		expect(buildFtsQuery(["cache", "invalidação"])).toBe('"cache"* OR "invalidação"*');
	});

	it("duplica aspas internas (sem escape por barra no FTS5)", () => {
		expect(buildFtsQuery(['say "hi"'])).toBe('"say ""hi"""*');
	});

	it("filtra termos vazios", () => {
		expect(buildFtsQuery(["", "  ", "foo"])).toBe('"foo"*');
	});

	it("retorna vazio sem termos", () => {
		expect(buildFtsQuery([])).toBe("");
	});
});

describe("MemoryIndex write sync", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let idx: MemoryIndex;

	function counts(): { docs: number; fts: number } {
		const probe = openProbe(dbPath);
		try {
			const d = probe.prepare("SELECT count(*) AS c FROM memory_documents").get() as { c: number };
			const f = probe.prepare("SELECT count(*) AS c FROM memory_fts").get() as { c: number };
			return { docs: Number(d.c), fts: Number(f.c) };
		} finally {
			probe.close();
		}
	}

	function docTitle(path: string): string {
		const probe = openProbe(dbPath);
		try {
			const row = probe
				.prepare("SELECT title FROM memory_documents WHERE path = ?")
				.get(path) as { title: string } | undefined;
			return row?.title ?? "";
		} finally {
			probe.close();
		}
	}

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-sync-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-sync-db-"));
		dbPath = join(dbDir, "sync.sqlite");
		proj = `__test_sync_${Date.now()}`;
		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("upsert insere documento novo (relacional + FTS)", () => {
		const doc = docFromFixture(
			root,
			`projects/${proj}/gotchas/a.md`,
			"type: gotchas\nconfidence: 0.7\n",
			"## [2026-08-08 10:00:00] Memória A\n\nconteúdo A sobre cache\n",
		);
		idx.upsertDocument(doc);
		expect(counts()).toEqual({ docs: 1, fts: 1 });
	});

	it("upsert atualiza documento existente (mesmo path, id preservado)", () => {
		const rel = `projects/${proj}/gotchas/a.md`;
		const probe = openProbe(dbPath);
		const before = probe
			.prepare("SELECT id, created_at FROM memory_documents WHERE path = ?")
			.get(rel) as { id: number; created_at: string };
		probe.close();

		const updated = docFromFixture(
			root,
			rel,
			"type: gotchas\nconfidence: 0.9\n",
			"## [2026-08-08 10:00:00] Memória A v2\n\nconteúdo A atualizado\n",
		);
		idx.upsertDocument(updated);

		expect(counts()).toEqual({ docs: 1, fts: 1 });
		expect(docTitle(rel)).toBe("Memória A v2");
		const after = openProbe(dbPath)
			.prepare("SELECT id, created_at FROM memory_documents WHERE path = ?")
			.get(rel) as { id: number; created_at: string };
		expect(after.id).toBe(before.id);
		expect(after.created_at).toBe(before.created_at);
	});

	it("removeDocument remove das duas tabelas; path inexistente é no-op", () => {
		const rel = `projects/${proj}/gotchas/a.md`;
		idx.removeDocument(rel);
		expect(counts()).toEqual({ docs: 0, fts: 0 });
		expect(() => idx.removeDocument("projects/x/gotchas/inexistente.md")).not.toThrow();
	});

	it("syncDocuments insere lote numa transação", () => {
		const docs = [
			docFromFixture(
				root,
				`projects/${proj}/gotchas/b.md`,
				"type: gotchas\nconfidence: 0.6\n",
				"## [2026-08-08] Memória B\n\nconteúdo B\n",
			),
			docFromFixture(
				root,
				`projects/${proj}/lessons/c.md`,
				"type: lessons\nconfidence: 0.6\n",
				"## [2026-08-08] Memória C\n\nconteúdo C\n",
			),
		];
		idx.syncDocuments(docs);
		expect(counts()).toEqual({ docs: 2, fts: 2 });
	});

	it("syncDocuments com lista vazia é no-op", () => {
		idx.syncDocuments([]);
		expect(counts()).toEqual({ docs: 2, fts: 2 });
	});

	it("updateConfidence atualiza metadados sem reindexar FTS", () => {
		const rel = `projects/${proj}/gotchas/b.md`;
		idx.updateConfidence(rel, 0.4, "2026-08-09");
		const probe = openProbe(dbPath);
		try {
			const doc = probe
				.prepare("SELECT confidence, updated FROM memory_documents WHERE path = ?")
				.get(rel) as { confidence: number; updated: string };
			expect(doc.confidence).toBe(0.4);
			expect(doc.updated).toBe("2026-08-09");
			expect(Number((probe.prepare("SELECT count(*) AS c FROM memory_fts").get() as { c: number }).c)).toBe(2);
		} finally {
			probe.close();
		}
	});

	it("upsert de documento não-último não corrompe rowids FTS (regressão lastInsertRowid)", () => {
		// Corrupção reproduzida: inserir A, B, C e depois atualizar A (primeiro
		// inserido). O lastInsertRowid pós-UPSERT (ramo UPDATE) apontava para o
		// rowid de OUTRO documento — o FTS de A ficava obsoleto e o conteúdo novo
		// era gravado no FTS de B.
		const relA = `projects/${proj}/gotchas/reg-a.md`;
		const relB = `projects/${proj}/gotchas/reg-b.md`;
		const relC = `projects/${proj}/gotchas/reg-c.md`;

		idx.upsertDocument(
			docFromFixture(root, relA, "type: gotchas\nconfidence: 0.6\n", "## [2026-08-08 10:00:00] Reg A\n\nalpha-antigo único\n"),
		);
		idx.upsertDocument(
			docFromFixture(root, relB, "type: gotchas\nconfidence: 0.6\n", "## [2026-08-08 10:00:00] Reg B\n\nbravo único\n"),
		);
		idx.upsertDocument(
			docFromFixture(root, relC, "type: gotchas\nconfidence: 0.6\n", "## [2026-08-08 10:00:00] Reg C\n\ncharlie único\n"),
		);
		let c = counts();
		expect(c.docs).toBe(c.fts);

		// Atualiza A — não é o último documento inserido
		idx.upsertDocument(
			docFromFixture(root, relA, "type: gotchas\nconfidence: 0.6\n", "## [2026-08-08 10:00:00] Reg A v2\n\nalpha-novo único\n"),
		);
		c = counts();
		expect(c.docs).toBe(c.fts);

		const search = (term: string) =>
			idx.search({ terms: [term], projectId: proj }).map((r) => r.path);

		// Texto antigo de A não existe mais
		expect(search("alpha-antigo")).toEqual([]);
		// Texto novo aparece SOMENTE em A
		expect(search("alpha-novo")).toEqual([relA]);
		// B e C intactos — no bug, B perdia o FTS e recebia conteúdo de A
		expect(search("bravo")).toEqual([relB]);
		expect(search("charlie")).toEqual([relC]);
	});
});

describe("MemoryIndex syncMutation (supersedes/consolidate)", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let idx: MemoryIndex;
	let relA: string;
	let relB: string;
	let relC: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-mut-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-mut-db-"));
		dbPath = join(dbDir, "mut.sqlite");
		proj = `__test_mut_${Date.now()}`;
		relA = `projects/${proj}/gotchas/sup-a.md`;
		relB = `projects/${proj}/lessons/sup-b.md`;
		relC = `projects/${proj}/gotchas/cons-c.md`;

		// A (será superseded por B), B, C (será consolidado no mesmo path)
		writeFixture(root, relA, "type: gotchas\nupdated: 2026-08-01\n", "## [2026-08-01] A\n\ntoken-antigo-a\n");
		writeFixture(root, relB, "type: lessons\nupdated: 2026-08-01\n", "## [2026-08-01] B\n\ntoken-b-original\n");
		writeFixture(root, relC, "type: gotchas\nupdated: 2026-08-01\n", "## [2026-08-01] C\n\ntoken-c-v1\n");

		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	function searchPaths(terms: string[]): string[] {
		return idx.search({ terms, projectId: proj }).map((r) => r.path);
	}

	it("remove path arquivado e upsert do novo na mesma transação (supersedes)", () => {
		const relB2 = `projects/${proj}/lessons/sup-b.md`;
		writeFixture(
			root,
			relB2,
			"type: lessons\nupdated: 2026-08-02\n",
			"## [2026-08-02] B2\n\ntoken-novo-b\n",
		);

		idx.syncMutation({
			upsert: [readMemoryDocFromFile(join(root, relB2), relB2)],
			remove: [relA], // A foi para .supersedes/ no save
		});

		// Antiga A não é mais buscável
		expect(searchPaths(["token-antigo-a"])).not.toContain(relA);
		// B atualizado é buscável
		expect(searchPaths(["token-novo-b"])).toContain(relB2);
		// C intocada
		expect(searchPaths(["token-c-v1"])).toContain(relC);

		// Relacional e FTS consistentes
		const probe = openProbe(dbPath);
		try {
			const d = probe.prepare("SELECT count(*) AS c FROM memory_documents").get() as { c: number };
			const f = probe.prepare("SELECT count(*) AS c FROM memory_fts").get() as { c: number };
			expect(Number(d.c)).toBe(Number(f.c));
			const row = probe
				.prepare("SELECT path FROM memory_documents WHERE path = ?")
				.get(relA) as { path: string } | undefined;
			expect(row).toBeUndefined();
		} finally {
			probe.close();
		}
	});

	it("path em remove E upsert termina indexado (consolidate mesmo path)", () => {
		writeFixture(
			root,
			relC,
			"type: gotchas\nupdated: 2026-08-02\n",
			"## [2026-08-02] C2\n\ntoken-c-v2\n",
		);

		idx.syncMutation({
			upsert: [readMemoryDocFromFile(join(root, relC), relC)],
			remove: [relC], // arquivado e recriado no mesmo path
		});

		expect(searchPaths(["token-c-v1"])).not.toContain(relC);
		expect(searchPaths(["token-c-v2"])).toContain(relC);
	});

	it("lista vazia é no-op", () => {
		expect(() => idx.syncMutation({ upsert: [], remove: [] })).not.toThrow();
	});

	it("remove de path inexistente é no-op", () => {
		expect(() =>
			idx.syncMutation({ upsert: [], remove: ["projects/x/gotchas/inexistente.md"] }),
		).not.toThrow();
	});
});

describe("MemoryIndex search", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let idx: MemoryIndex;

	const rel = (name: string, type = "gotchas") => `projects/${proj}/${type}/${name}.md`;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-search-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-search-db-"));
		dbPath = join(dbDir, "search.sqlite");
		proj = `__test_search_${Date.now()}`;

		// Global
		writeFixture(root, "_global/gotchas/titulo.md", "type: gotchas\nconfidence: 0.7\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Cache invalidação\n\nconteúdo genérico aqui\n");
		writeFixture(root, "_global/gotchas/corpo.md", "type: gotchas\nconfidence: 0.7\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Outra lição\n\ntexto sobre cache no corpo\n");
		writeFixture(root, "_global/gotchas/banana.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Banana\n\napenas banana split\n");
		writeFixture(root, "_global/gotchas/frase.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Frase\n\neste é um conteúdo específico para testar\n");
		writeFixture(root, "_global/gotchas/quotes.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n", '## [2026-08-01 10:00:00] Quotes\n\nele disse say "hello" mundo\n');
		writeFixture(root, "_global/gotchas/underscore.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Underscore\n\nvariavel id_snake_case aqui\n");
		writeFixture(root, "_global/gotchas/baixo.md", "type: gotchas\nconfidence: 0.3\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Baixa confiança\n\ncache com confiança baixa\n");
		writeFixture(root, "_global/gotchas/summary.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\nsummary: \"resumo rápido de testes\"\n", "## [2026-08-01 10:00:00] Resumo\n\ncorpo vazio aqui\n");
		writeFixture(root, "_global/gotchas/tags.md", "type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\ntags: [\"snapshot\"]\n", "## [2026-08-01 10:00:00] Tags\n\ncorpo sem a palavra\n");

		// Projeto (proj-only sem "cache" para dar discriminação idf ao termo)
		writeFixture(root, rel("proj-only", "lessons"), "type: lessons\nconfidence: 0.7\nupdated: 2026-08-01\n", "## [2026-08-01 10:00:00] Projeto\n\nconteúdo de projeto\n");
		writeFixture(root, rel("antigo"), "type: gotchas\nconfidence: 0.7\nupdated: 2026-01-01\n", "## [2026-01-01 10:00:00] Antigo\n\ncache match antigo\n");
		writeFixture(root, rel("novo"), "type: gotchas\nconfidence: 0.7\nupdated: 2026-08-08\n", "## [2026-08-08 10:00:00] Novo\n\ncache match novo\n");

		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	function search(terms: string[], opts: Partial<Parameters<MemoryIndex["search"]>[0]> = {}): ReturnType<MemoryIndex["search"]> {
		return idx.search({ terms, projectId: proj, ...opts });
	}

	function paths(results: ReturnType<MemoryIndex["search"]>): string[] {
		return results.map((r) => r.path);
	}

	it("encontra por título, corpo, summary e tags", () => {
		expect(paths(search(["cache"]))).toContain("_global/gotchas/titulo.md");
		expect(paths(search(["cache"]))).toContain("_global/gotchas/corpo.md");
		expect(paths(search(["rápido"]))).toContain("_global/gotchas/summary.md");
		expect(paths(search(["snapshot"]))).toContain("_global/gotchas/tags.md");
	});

	it("remove diacríticos na busca (PT-BR sem acento)", () => {
		expect(paths(search(["invalidação"]))).toContain("_global/gotchas/titulo.md");
		expect(paths(search(["invalidacao"]))).toContain("_global/gotchas/titulo.md");
	});

	it("identificador underscore: exato/prefixo no token original; componente via norm", () => {
		expect(paths(search(["id_snake_case"]))).toContain("_global/gotchas/underscore.md");
		expect(paths(search(["id_snake"]))).toContain("_global/gotchas/underscore.md");
		// "snake" é componente interno — encontrado pela coluna norm
		expect(paths(search(["snake"]))).toContain("_global/gotchas/underscore.md");
	});

	it("OR entre termos", () => {
		const p = paths(search(["banana", "cache"]));
		expect(p).toContain("_global/gotchas/banana.md");
		expect(p).toContain("_global/gotchas/titulo.md");
	});

	it("termo com espaço vira frase (adjacência)", () => {
		expect(paths(search(["conteúdo específico"]))).toContain("_global/gotchas/frase.md");
		expect(paths(search(["conteúdo específico"]))).not.toContain("_global/gotchas/titulo.md");
	});

	it("escape de aspas na query", () => {
		expect(paths(search(['say "hello"']))).toContain("_global/gotchas/quotes.md");
	});

	it("filtra por escopo global", () => {
		const p = paths(search(["cache"], { scope: "global" }));
		for (const path of p) expect(path.startsWith("_global/")).toBeTrue();
		expect(p).not.toContain(rel("novo"));
		expect(p).not.toContain(rel("proj-only", "lessons"));
	});

	it("filtra por escopo projeto", () => {
		const p = paths(search(["projeto"], { scope: "project" }));
		expect(p).toContain(rel("proj-only", "lessons"));
		for (const path of p) expect(path.startsWith("projects/")).toBeTrue();
	});

	it("filtra por tipo", () => {
		const p = paths(search(["projeto"], { type: "lessons" }));
		expect(p).toContain(rel("proj-only", "lessons"));
		expect(p).not.toContain("_global/gotchas/titulo.md");
	});

	it("filtra por minConfidence", () => {
		const p = paths(search(["cache"], { minConfidence: 0.5 }));
		expect(p).not.toContain("_global/gotchas/baixo.md");
		expect(p).toContain("_global/gotchas/titulo.md");
	});

	it("ranking: título vence corpo", () => {
		const results = search(["cache"]);
		expect(results[0].path).toBe("_global/gotchas/titulo.md");
	});

	it("ranking: match lexical vence recência; recência desempata", () => {
		const results = search(["cache"]);
		const novoIdx = results.findIndex((r) => r.path === rel("novo"));
		const antigoIdx = results.findIndex((r) => r.path === rel("antigo"));
		expect(novoIdx).toBeGreaterThanOrEqual(0);
		expect(antigoIdx).toBeGreaterThanOrEqual(0);
		expect(novoIdx).toBeLessThan(antigoIdx);
	});

	it("respeita limit", () => {
		expect(search(["cache"], { limit: 2 })).toHaveLength(2);
	});

	it("sem match retorna vazio; termos vazios também", () => {
		expect(search(["zzz_nao_existe_12345"])).toEqual([]);
		expect(search([])).toEqual([]);
	});

	it("snippet contém o termo no corpo", () => {
		const corpo = search(["cache"]).find((r) => r.path === "_global/gotchas/corpo.md");
		expect(corpo).toBeDefined();
		expect(corpo!.snippet).toContain("cache");
	});

	it("exige projectId fora do escopo global", () => {
		expect(() => idx.search({ terms: ["cache"], scope: "project" })).toThrow(/projectId/);
		expect(() => idx.search({ terms: ["cache"], scope: "all" })).toThrow(/projectId/);
	});

	it("busca bloqueia com needsRebuild", () => {
		const freshDb = join(dbDir, "fresh.sqlite");
		const fresh = new MemoryIndex(freshDb, root);
		fresh.open();
		expect(fresh.needsRebuild).toBeTrue();
		expect(() => fresh.search({ terms: ["cache"], projectId: proj })).toThrow(/rebuild/);
		fresh.close();
	});

	it("upsert/remove refletem na busca (integração F2+F3)", () => {
		const relFile = rel("dinamico");
		const doc = docFromFixture(
			root,
			relFile,
			"type: gotchas\nconfidence: 0.6\n",
			"## [2026-08-08 10:00:00] Dinâmico\n\ntoken especial único\n",
		);
		idx.upsertDocument(doc);
		expect(paths(search(["especial"]))).toContain(relFile);

		const updated = docFromFixture(
			root,
			relFile,
			"type: gotchas\nconfidence: 0.6\n",
			"## [2026-08-08 10:00:00] Dinâmico v2\n\ntoken alterado único\n",
		);
		idx.upsertDocument(updated);
		expect(paths(search(["especial"]))).not.toContain(relFile);
		expect(paths(search(["alterado"]))).toContain(relFile);

		idx.removeDocument(relFile);
		expect(paths(search(["alterado"]))).not.toContain(relFile);
	});
});

describe("MemoryIndex ranking (lexical decide; metadado só desempata)", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let idx: MemoryIndex;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-rank-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-rank-db-"));
		dbPath = join(dbDir, "rank.sqlite");
		proj = `__test_rank_${Date.now()}`;

		// Adversarial: match no TÍTULO, antigo e confiança baixa — deve vencer
		// match no CORPO, recente e confiança alta (regressão do boost aditivo).
		writeFixture(
			root,
			`projects/${proj}/gotchas/title-antigo.md`,
			"type: gotchas\nconfidence: 0.5\nupdated: 2020-01-01\n",
			"## [2020-01-01 10:00:00] needle exato no título\n\nconteúdo genérico\n",
		);
		writeFixture(
			root,
			`projects/${proj}/gotchas/body-novo.md`,
			"type: gotchas\nconfidence: 0.9\nupdated: 2026-08-08\n",
			"## [2026-08-08 10:00:00] Outra lição\n\nneedle aparece só no corpo\n",
		);

		// Empate lexical no corpo (mesmo texto/coluna) → confiança desempata.
		const corpo = "## [2026-08-08 10:00:00] X\n\nneedle no corpo do documento\n";
		writeFixture(
			root,
			`projects/${proj}/gotchas/corpo-velho.md`,
			"type: gotchas\nconfidence: 0.5\nupdated: 2026-01-01\n",
			corpo,
		);
		writeFixture(
			root,
			`projects/${proj}/gotchas/corpo-recente.md`,
			"type: gotchas\nconfidence: 0.9\nupdated: 2026-08-08\n",
			corpo,
		);

		// Empate lexical + confiança → updated desempata.
		const tie = "## [2026-08-08 10:00:00] T\n\nneedle único de desempate\n";
		writeFixture(
			root,
			`projects/${proj}/gotchas/tie-velho.md`,
			"type: gotchas\nconfidence: 0.7\nupdated: 2020-05-05\n",
			tie,
		);
		writeFixture(
			root,
			`projects/${proj}/gotchas/tie-novo.md`,
			"type: gotchas\nconfidence: 0.7\nupdated: 2026-08-08\n",
			tie,
		);

		// Irrelevante: recente e confiança alta, mas SEM o termo.
		writeFixture(
			root,
			`projects/${proj}/gotchas/irrelevante.md`,
			"type: gotchas\nconfidence: 0.95\nupdated: 2099-01-01\n",
			"## [2099-01-01 10:00:00] Irrelevante\n\nnada a ver com nada\n",
		);

		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	function search(
		terms: string[],
		opts: Partial<Parameters<MemoryIndex["search"]>[0]> = {},
	): ReturnType<MemoryIndex["search"]> {
		return idx.search({ terms, projectId: proj, ...opts });
	}

	function paths(results: ReturnType<MemoryIndex["search"]>): string[] {
		return results.map((r) => r.path);
	}

	it("match no título vence match no corpo mesmo com confiança/recência contra", () => {
		const results = search(["needle"]);
		const title = results.find((r) => r.path.includes("title-antigo.md"));
		const body = results.find((r) => r.path.includes("body-novo.md"));
		expect(results[0].path).toContain("title-antigo.md");
		expect(title).toBeDefined();
		expect(body).toBeDefined();
		// score é lexical (-bm25): título (peso 8) > corpo (peso 1)
		expect(title!.score).toBeGreaterThan(body!.score);
	});

	it("memória recente/confiança alta sem o termo não aparece", () => {
		expect(paths(search(["needle"]))).not.toContain(
			`projects/${proj}/gotchas/irrelevante.md`,
		);
	});

	it("empate lexical desempata por confiança", () => {
		const results = search(["needle"]);
		const velho = results.findIndex((r) => r.path.includes("corpo-velho.md"));
		const recente = results.findIndex((r) => r.path.includes("corpo-recente.md"));
		expect(velho).toBeGreaterThanOrEqual(0);
		expect(recente).toBeGreaterThanOrEqual(0);
		expect(recente).toBeLessThan(velho);
	});

	it("empate lexical + confiança desempata por updated", () => {
		const results = search(["needle"]);
		const velho = results.findIndex((r) => r.path.includes("tie-velho.md"));
		const novo = results.findIndex((r) => r.path.includes("tie-novo.md"));
		expect(velho).toBeGreaterThanOrEqual(0);
		expect(novo).toBeGreaterThanOrEqual(0);
		expect(novo).toBeLessThan(velho);
	});
});

describe("MemoryIndex busca por componentes (coluna norm)", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let idx: MemoryIndex;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-norm-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-norm-db-"));
		dbPath = join(dbDir, "norm.sqlite");
		proj = `__test_norm_${Date.now()}`;

		writeFixture(
			root,
			"_global/gotchas/underscore.md",
			"type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] Underscore\n\nvariavel id_snake_case aqui\n",
		);
		// Só a norm casa "snake" (id_ prefixa o token original) vs. token
		// isolado no corpo (casa no campo real + norm).
		writeFixture(
			root,
			`projects/${proj}/gotchas/comp.md`,
			"type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] Comp\n\nid_snake_case no corpo\n",
		);
		writeFixture(
			root,
			`projects/${proj}/gotchas/exact.md`,
			"type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] Exact\n\ntermo snake isolado aqui\n",
		);
		// - / . já eram separadores no unicode61 — norm não deve regredir.
		writeFixture(
			root,
			`projects/${proj}/gotchas/paths.md`,
			"type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] Paths\n\ncaminho a/b c.d e-f\n",
		);

		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	function search(
		terms: string[],
		opts: Partial<Parameters<MemoryIndex["search"]>[0]> = {},
	): ReturnType<MemoryIndex["search"]> {
		return idx.search({ terms, projectId: proj, ...opts });
	}

	function paths(results: ReturnType<MemoryIndex["search"]>): string[] {
		return results.map((r) => r.path);
	}

	it("componente interno de identificador (snake de id_snake_case) é encontrável", () => {
		const p = paths(search(["snake"]));
		expect(p).toContain("_global/gotchas/underscore.md");
		expect(p).toContain(`projects/${proj}/gotchas/comp.md`);
	});

	it("identificador exato e prefixo continuam casando", () => {
		expect(paths(search(["id_snake_case"]))).toContain("_global/gotchas/underscore.md");
		expect(paths(search(["id_snake"]))).toContain("_global/gotchas/underscore.md");
	});

	it("match no campo real rankeia acima de match só-norm", () => {
		const results = search(["snake"]);
		const exact = results.findIndex((r) => r.path.includes("exact.md"));
		const comp = results.findIndex((r) => r.path.includes("comp.md"));
		expect(exact).toBeGreaterThanOrEqual(0);
		expect(comp).toBeGreaterThanOrEqual(0);
		expect(exact).toBeLessThan(comp);
	});

	it("- / . seguem separando tokens (sem regressão)", () => {
		expect(paths(search(["b"]))).toContain(`projects/${proj}/gotchas/paths.md`);
		expect(paths(search(["e"]))).toContain(`projects/${proj}/gotchas/paths.md`);
	});
});

describe("normalizeForSearch", () => {
	it("separa _ - / . e colapsa espaços", () => {
		expect(normalizeForSearch("a_b", "x", ["t1"], "c.d e-f g/h")).toBe(
			"a b x t1 c d e f g h",
		);
	});

	it("sem summary/tags", () => {
		expect(normalizeForSearch("t", null, [], "corpo")).toBe("t corpo");
	});
});

describe("MemoryIndex migração de schema v1 → v2", () => {
	it("reindexa FTS com coluna norm a partir do markdown, preservando docs", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-mig-root-"));
		const dbDir = mkdtempSync(join(tmpdir(), "pi-memory-mig-db-"));
		const dbPath = join(dbDir, "v1.sqlite");
		const projA = `__test_mig_a_${Date.now()}`;
		const projB = `__test_mig_b_${Date.now()}`;

		// Markdown canônico (fonte da verdade)
		writeFixture(
			root,
			"_global/gotchas/g1.md",
			"type: gotchas\nconfidence: 0.7\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] Global\n\nvariavel id_snake_case global\n",
		);
		writeFixture(
			root,
			`projects/${projA}/gotchas/p1.md`,
			"type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] A\n\nconteúdo projeto A\n",
		);
		writeFixture(
			root,
			`projects/${projB}/gotchas/p2.md`,
			"type: gotchas\nconfidence: 0.6\nupdated: 2026-08-01\n",
			"## [2026-08-01 10:00:00] B\n\nconteúdo projeto B\n",
		);

		// Banco v1 construído à mão (FTS de 4 colunas, sem norm)
		const raw = new DatabaseSync(dbPath);
		raw.exec(`CREATE TABLE memory_documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL UNIQUE,
			scope TEXT NOT NULL CHECK (scope IN ('global','project')),
			project_id TEXT,
			type TEXT NOT NULL,
			context TEXT NOT NULL,
			title TEXT NOT NULL,
			summary TEXT,
			tags_json TEXT NOT NULL DEFAULT '[]',
			confidence REAL NOT NULL,
			updated TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			modified_at TEXT NOT NULL)`);
		raw.exec(
			`CREATE VIRTUAL TABLE memory_fts USING fts5(title, summary, tags, body, ` +
				`tokenize = "unicode61 remove_diacritics 2 tokenchars '_'")`,
		);
		raw.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		raw.exec("INSERT INTO index_meta VALUES ('schema_version', '1')");
		const ins = raw.prepare(
			`INSERT INTO memory_documents
			   (path, scope, project_id, type, context, title, confidence, updated,
			    content_hash, created_at, modified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		ins.run(
			"_global/gotchas/g1.md",
			"global",
			null,
			"gotchas",
			"g1",
			"Global",
			0.7,
			"2026-08-01",
			"h1",
			"now",
			"now",
		);
		ins.run(
			`projects/${projA}/gotchas/p1.md`,
			"project",
			projA,
			"gotchas",
			"p1",
			"A",
			0.6,
			"2026-08-01",
			"h2",
			"now",
			"now",
		);
		ins.run(
			`projects/${projB}/gotchas/p2.md`,
			"project",
			projB,
			"gotchas",
			"p2",
			"B",
			0.6,
			"2026-08-01",
			"h3",
			"now",
			"now",
		);
		raw.close();

		try {
			const idx = new MemoryIndex(dbPath, root);
			idx.open(); // migra v1 → v2
			expect(idx.needsRebuild).toBeFalse();
			expect(idx.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));

			// FTS recriado com coluna norm; doc × FTS consistentes
			const probe = openProbe(dbPath);
			const cols = probe.prepare("PRAGMA table_info(memory_fts)").all() as {
				name: string;
			}[];
			expect(cols.map((c) => c.name)).toContain("norm");
			expect(
				Number(
					(probe.prepare("SELECT count(*) AS c FROM memory_documents").get() as { c: number })
						.c,
				),
			).toBe(3);
			expect(
				Number(
					(probe.prepare("SELECT count(*) AS c FROM memory_fts").get() as { c: number })
						.c,
				),
			).toBe(3);
			probe.close();

			// Busca por componente (norm) funciona pós-migração
			expect(
				idx
					.search({ terms: ["snake"], projectId: projA })
					.some((r) => r.path === "_global/gotchas/g1.md"),
			).toBeTrue();
			// Outros projetos preservados
			expect(
				idx
					.search({ terms: ["projeto"], projectId: projA })
					.some((r) => r.path === `projects/${projA}/gotchas/p1.md`),
			).toBeTrue();
			expect(
				idx
					.search({ terms: ["projeto"], scope: "project", projectId: projB })
					.some((r) => r.path === `projects/${projB}/gotchas/p2.md`),
			).toBeTrue();
			idx.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(dbDir, { recursive: true, force: true });
		}
	});
});

describe("MemoryIndex syncIncremental", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let otherProj: string;
	let idx: MemoryIndex;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-syncinc-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-syncinc-db-"));
		dbPath = join(dbDir, "syncinc.sqlite");
		proj = `__test_syncinc_${Date.now()}`;
		otherProj = `${proj}_other`;

		// Outro projeto (teste de isolamento) + projeto alvo + global
		writeFixture(root, `projects/${otherProj}/gotchas/outro.md`, "type: gotchas\nconfidence: 0.7\n", "## [2026-08-01 10:00:00] Outro\n\nconteúdo do outro projeto\n");
		writeFixture(root, "_global/_rules/regra.md", "type: _rules\nconfidence: 0.8\n", "## [2026-08-01 10:00:00] Regra\n\nregra global\n");
		writeFixture(root, `projects/${proj}/gotchas/base.md`, "type: gotchas\nconfidence: 0.6\n", "## [2026-08-01 10:00:00] Base\n\nconteúdo base original\n");

		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(otherProj); // indexa outro (fica no banco)
		idx.rebuild(proj); // indexa regra + base; preserva outro
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	function search(terms: string[], opts: Partial<Parameters<MemoryIndex["search"]>[0]> = {}): ReturnType<MemoryIndex["search"]> {
		return idx.search({ terms, projectId: proj, ...opts });
	}

	function paths(results: ReturnType<MemoryIndex["search"]>): string[] {
		return results.map((r) => r.path);
	}

	it("banco novo: sync = rebuild (added = total)", () => {
		const freshDb = join(dbDir, "fresh.sqlite");
		const fresh = new MemoryIndex(freshDb, root);
		fresh.open();
		expect(fresh.needsRebuild).toBeTrue();
		const s = fresh.syncIncremental(proj);
		expect(s.added).toBe(2); // regra (global) + base (projeto)
		expect(s.updated).toBe(0);
		expect(s.removed).toBe(0);
		expect(fresh.needsRebuild).toBeFalse();
		// Sem mudanças depois — segundo sync é no-op
		const s2 = fresh.syncIncremental(proj);
		expect(s2.added).toBe(0);
		expect(s2.updated).toBe(0);
		expect(s2.removed).toBe(0);
		fresh.close();
	});

	it("sem mudanças no disco: no-op", () => {
		const s = idx.syncIncremental(proj);
		expect(s).toEqual({ added: 0, updated: 0, removed: 0, skipped: 0 });
	});

	it("arquivo novo no disco é adicionado e vira buscável", () => {
		writeFixture(root, `projects/${proj}/lessons/nova.md`, "type: lessons\nconfidence: 0.6\n", "## [2026-08-02 10:00:00] Nova\n\nconteúdo totalmente novo aqui\n");
		const s = idx.syncIncremental(proj);
		expect(s.added).toBe(1);
		expect(paths(search(["totalmente"]))).toContain(`projects/${proj}/lessons/nova.md`);
	});

	it("edição manual fora das tools (hash diverge) atualiza", () => {
		writeFixture(root, `projects/${proj}/gotchas/base.md`, "type: gotchas\nconfidence: 0.6\n", "## [2026-08-01 10:00:00] Base editada\n\nconteúdo base ORIGINAL editado à mão\n");
		const s = idx.syncIncremental(proj);
		expect(s.updated).toBe(1);
		expect(s.added).toBe(0);
		// Conteúdo antigo sumiu da busca; novo apareceu
		expect(paths(search(["original"]))).toContain(`projects/${proj}/gotchas/base.md`);
		const oldHits = search(["original"]).filter((r) => r.path === `projects/${proj}/gotchas/base.md`);
		// O termo "ORIGINAL editado à mão" — sem o termo antigo "conteúdo base original" como frase única
		expect(oldHits.length).toBe(1);
	});

	it("arquivo deletado do disco é removido do índice", () => {
		rmSync(join(root, `projects/${proj}/lessons/nova.md`), { force: true });
		const s = idx.syncIncremental(proj);
		expect(s.removed).toBe(1);
		expect(paths(search(["totalmente"]))).not.toContain(`projects/${proj}/lessons/nova.md`);
	});

	it("não mexe em documentos de outros projetos", () => {
		idx.syncIncremental(proj);
		expect(docPaths(dbPath)).toContain(`projects/${otherProj}/gotchas/outro.md`);
	});
});

describe("MemoryIndex syncMutationSafe", () => {
	let root: string;
	let dbDir: string;
	let dbPath: string;
	let proj: string;
	let idx: MemoryIndex;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-safe-root-"));
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-safe-db-"));
		dbPath = join(dbDir, "safe.sqlite");
		proj = `__test_safe_${Date.now()}`;
		writeFixture(root, `projects/${proj}/gotchas/a.md`, "type: gotchas\nconfidence: 0.7\n", "## [2026-08-08 10:00:00] A\n\nconteúdo A\n");
		idx = new MemoryIndex(dbPath, root);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("sucesso: {ok:true} e documento sincronizado", () => {
		const doc = docFromFixture(
			root,
			`projects/${proj}/gotchas/b.md`,
			"type: gotchas\nconfidence: 0.6\n",
			"## [2026-08-08 10:00:00] B\n\nconteúdo B\n",
		);
		const r = idx.syncMutationSafe({ upsert: [doc], remove: [] });
		expect(r).toEqual({ ok: true });
		expect(docPaths(dbPath)).toContain(`projects/${proj}/gotchas/b.md`);
	});

	it("falha (índice fechado): {ok:false, error} sem lançar e marca needsRebuild", () => {
		const closed = new MemoryIndex(join(dbDir, "closed.sqlite"), root);
		closed.open();
		closed.rebuild(proj);
		closed.close();

		const doc = docFromFixture(
			root,
			`projects/${proj}/gotchas/c.md`,
			"type: gotchas\nconfidence: 0.6\n",
			"## [2026-08-08 10:00:00] C\n\nconteúdo C\n",
		);
		expect(() => closed.syncMutationSafe({ upsert: [doc], remove: [] })).not.toThrow();
		const r = closed.syncMutationSafe({ upsert: [doc], remove: [] });
		expect(r.ok).toBe(false);
		expect(typeof r.error).toBe("string");
		expect(closed.needsRebuild).toBe(true);
	});

	it("falha de remoção também degrada sem lançar", () => {
		const closed = new MemoryIndex(join(dbDir, "closed2.sqlite"), root);
		closed.open();
		closed.rebuild(proj);
		closed.close();
		const r = closed.syncMutationSafe({ upsert: [], remove: [`projects/${proj}/gotchas/a.md`] });
		expect(r.ok).toBe(false);
		expect(closed.needsRebuild).toBe(true);
	});
});
