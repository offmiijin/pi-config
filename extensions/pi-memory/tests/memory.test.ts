/**
 * pi-memory — Tests: memory.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// identifyProject aceita um runner de git injetado (2º parâmetro) — os
// testes de remote usam fake, sem depender do binário git nem de mocking
// de módulo (git init real falha dentro do sandbox: /dev/null bloqueado).

import {
	MEMORIES_ROOT,
	MEMORY_TYPES,
	ensureDirectories,
	getMemoryDirectories,
	identifyProject
} from "../constants.ts";

import {
	ensureFileDir
} from "../session.ts";

import {
	applyDecay,
	findMemoryFile,
	formatFrontmatter,
	formatMemoryIndexText,
	getMemoryFilePath,
	getMemoryStats,
	getSupersedesPath,
	listMemoryContexts,
	listMemoryIndex,
	migrateLegacyMemories,
	migrateMemoryToSnapshot,
	moveToSupersedes,
	type MemoryIndexEntry,
	parseFrontmatter,
	sanitizeFilename,
	saveMemory,
} from "../memory/memory.ts";

describe("identifyProject", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		const testProjectDir = join(MEMORIES_ROOT, "test_project");
		if (existsSync(testProjectDir)) {
			rmSync(testProjectDir, { recursive: true, force: true });
		}
	});

	it("extracts project id from git remote origin (SSH format)", () => {
		expect(identifyProject(tmpDir, () => "git@github.com:user/my-project.git")).toBe("github.com_user_my-project");
	});

	it("extracts project id from git remote origin (HTTPS format)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-https-"));
		expect(identifyProject(dir, () => "https://github.com/org/repo-name.git")).toBe("github.com_org_repo-name");
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to __unmanaged_<hash> when no git remote", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-nogit-"));
		const result = identifyProject(dir);
		expect(result).toMatch(/^__unmanaged_[a-f0-9]{12}$/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back when cwd does not exist", () => {
		const result = identifyProject("/non/existent/path/xyz123");
		expect(result).toMatch(/^__unmanaged_[a-f0-9]{12}$/);
	});

	it("is deterministic for the same cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-det-"));
		const a = identifyProject(dir);
		const b = identifyProject(dir);
		expect(a).toBe(b);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("getMemoryDirectories", () => {
	it("returns MEMORIES_ROOT as first entry", () => {
		const dirs = getMemoryDirectories("test_project");
		expect(dirs[0]).toBe(MEMORIES_ROOT);
	});

	it("includes all 5 global type directories under _global", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, "_global", t));
		}
	});

	it("includes supersedes directories for all global types", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, ".supersedes", "_global", t));
		}
	});

	it("includes all 5 project type directories", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, "projects", "test_project", t));
		}
	});

	it("não inclui mais diretório sessions (pipeline grava só em SQLite)", () => {
		const dirs = getMemoryDirectories("test_project");
		expect(dirs).not.toContain(join(MEMORIES_ROOT, "projects", "test_project", "sessions"));
	});

	it("includes supersedes project directories", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, ".supersedes", "projects", "test_project", t));
		}
	});

	it("returns correct number of directories", () => {
		const dirs = getMemoryDirectories("test_project");
		expect(dirs).toHaveLength(1 + 5 + 5 + 5 + 5 + 5 + 5);
	});
});

describe("ensureDirectories", () => {
	const TEST_PROJECT = "ensure_test";

	afterAll(() => {
		// Remove SÓ o que o teste cria (projects/ensure_test).
		// NUNCA remover MEMORIES_ROOT ou _global/<types>: podem conter
		// memórias reais do usuário. A versão antiga deletava MEMORIES_ROOT
		// inteiro (recursivo) em toda execução de teste — destruindo
		// memórias globais e de todos os projetos.
		const testDirs = [
			join(MEMORIES_ROOT, "projects", TEST_PROJECT),
			join(MEMORIES_ROOT, ".supersedes", "projects", TEST_PROJECT),
		];
		for (const dir of testDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates all directories for the given project", () => {
		const created = ensureDirectories(TEST_PROJECT);
		for (const dir of created) {
			expect(existsSync(dir)).toBeTrue();
		}
	});

	it("is idempotent (safe to call twice)", () => {
		const first = ensureDirectories(TEST_PROJECT);
		const second = ensureDirectories(TEST_PROJECT);
		expect(second).toEqual(first);
		for (const dir of second) {
			expect(existsSync(dir)).toBeTrue();
		}
	});

	it("returns all expected paths", () => {
		const dirs = ensureDirectories(TEST_PROJECT);
		expect(Array.isArray(dirs)).toBeTrue();
		expect(dirs.length).toBeGreaterThan(0);
	});
});

describe("sanitizeFilename", () => {
	it("lowercases and replaces spaces with hyphens", () => {
		
		expect(sanitizeFilename("Next.js App Router")).toBe("next-js-app-router");
	});

	it("removes non-alphanumeric characters", () => {
		expect(sanitizeFilename("React 19! @types")).toBe("react-19-types");
	});

	it("collapses multiple hyphens", () => {
		
		expect(sanitizeFilename("foo___bar!!baz")).toBe("foo-bar-baz");
	});

	it("trims leading and trailing hyphens", () => {
		
		expect(sanitizeFilename("!!hello!!")).toBe("hello");
	});

	it("returns empty string for all-special input", () => {
		
		expect(sanitizeFilename("!!!")).toBe("");
	});
});

describe("getMemoryFilePath", () => {
	it("returns path under _global for global scope", () => {
		
		const path = getMemoryFilePath("proj", "_rules", "Next.js Router", "global");
		expect(path).toContain("_global");
		expect(path).toContain("_rules");
		expect(path).toContain("next-js-router.md");
		expect(path.startsWith(MEMORIES_ROOT)).toBeTrue();
	});

	it("returns path under projects for project scope", () => {
		
		const path = getMemoryFilePath("my_project", "gotchas", "test-context", "project");
		expect(path).toContain("projects");
		expect(path).toContain("my_project");
		expect(path).toContain("gotchas");
		expect(path).toContain("test-context.md");
		expect(path.startsWith(MEMORIES_ROOT)).toBeTrue();
	});
});

describe("getSupersedesPath", () => {
	it("maps a global memory path to .supersedes", () => {
		
		const original = join(MEMORIES_ROOT, "_global", "_rules", "test.md");
		const sup = getSupersedesPath(original);
		expect(sup).toContain(".supersedes");
		expect(sup).toContain("_global");
		expect(sup).toContain("_rules");
		expect(sup).toContain("test.md");
	});

	it("maps a project memory path to .supersedes", () => {
		
		const original = join(MEMORIES_ROOT, "projects", "p1", "gotchas", "ctx.md");
		const sup = getSupersedesPath(original);
		expect(sup).toContain(".supersedes");
		expect(sup).toContain("projects");
		expect(sup).toContain("p1");
		expect(sup).toContain("ctx.md");
	});
});

describe("parseFrontmatter", () => {
	it("returns empty meta for content without frontmatter", () => {
		
		const { meta, body } = parseFrontmatter("# Just a heading\n\ncontent");
		expect(meta).toEqual({});
		expect(body).toBe("# Just a heading\n\ncontent");
	});

	it("parses simple frontmatter", () => {
		
		const fm = ["---", "context: test", "type: gotcha", "confidence: 0.7", "entries: 2", "---", "", "body here"].join("\n");
		const { meta, body } = parseFrontmatter(fm);
		expect(meta.context).toBe("test");
		expect(meta.type).toBe("gotcha");
		expect(meta.confidence).toBe(0.7);
		expect(meta.entries).toBe(2);
		expect(body.trim()).toBe("body here");
	});

	it("parses tags array", () => {
		
		const fm = ["---", 'tags: ["a", "b"]', "---", "", "body"].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.tags).toEqual(["a", "b"]);
	});

	it("handles boolean values", () => {
		
		const fm = ["---", "active: true", "done: false", "---", ""].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.active).toBeTrue();
		expect(meta.done).toBeFalse();
	});

	it("parses quoted string values", () => {
		const fm = ["---", 'reason: "substituída pela v15"', "---", ""].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.reason).toBe("substituída pela v15");
	});

	it("keeps quoted numbers as strings", () => {
		const fm = ["---", 'version: "2025-01-15"', "---", ""].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.version).toBe("2025-01-15");
	});
});

describe("formatFrontmatter", () => {
	it("formats simple metadata", () => {
		
		const result = formatFrontmatter({ context: "test", type: "gotcha" });
		expect(result.startsWith("---\n")).toBeTrue();
		expect(result).toContain("context: \"test\"");
		expect(result).toContain("type: \"gotcha\"");
		expect(result.endsWith("---\n")).toBeTrue();
	});

	it("formats tags array", () => {
		
		const result = formatFrontmatter({ tags: ["nextjs", "router"] });
		expect(result).toContain('tags: ["nextjs", "router"]');
	});

	it("formats number values", () => {
		
		const result = formatFrontmatter({ confidence: 0.7, entries: 3 });
		expect(result).toContain("confidence: 0.7");
		expect(result).toContain("entries: 3");
	});

	it("quotes strings containing colons", () => {
		const result = formatFrontmatter({ reason: "substituída pela v15" });
		expect(result).toContain("reason: \"substituída pela v15\"");
	});

	it("round-trips strings with colons, quotes and newlines", () => {
		const meta = { reason: 'API "v15": substituída\nnova linha' };
		const fm = formatFrontmatter(meta);
		const { meta: parsed } = parseFrontmatter(fm + "\nbody");
		expect(parsed.reason).toBe('API "v15": substituída\nnova linha');
	});
});

describe("listMemoryContexts", () => {
	let testProjectId: string;

	beforeAll(() => {
		testProjectId = `__test_ctx_${Date.now()}`;
		// Memória de projeto
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "proj-gotcha.md");
		ensureFileDir(fp);
		writeFileSync(fp, "---\ncontext: proj-gotcha\n---\n\ncontent");
		// Memória global
		const gfp = join(MEMORIES_ROOT, "_global", "lessons", "glob-lesson.md");
		ensureFileDir(gfp);
		writeFileSync(gfp, "---\ncontext: glob-lesson\n---\n\ncontent");
	});

	afterAll(() => {
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, "_global", "lessons", "glob-lesson.md"), { force: true });
	});

	it("lists project context keys", () => {
		const ctx = listMemoryContexts(testProjectId);
		expect(ctx.project).toContain("proj-gotcha");
	});

	it("lists global context keys", () => {
		const ctx = listMemoryContexts(testProjectId);
		expect(ctx.global).toContain("glob-lesson");
	});

	it("returns sorted keys", () => {
		const ctx = listMemoryContexts(testProjectId);
		expect([...ctx.global].sort()).toEqual(ctx.global);
		expect([...ctx.project].sort()).toEqual(ctx.project);
	});

	it("does not include session files", () => {
		const ctx = listMemoryContexts(testProjectId);
		for (const k of [...ctx.global, ...ctx.project]) {
			expect(k).not.toMatch(/^sessions/);
		}
	});
});

describe("applyDecay", () => {
	it("reduces confidence by delta", () => {
		expect(applyDecay(0.7, -0.3)).toBe(0.4);
	});

	it("treats positive delta as reduction", () => {
		expect(applyDecay(0.7, 0.3)).toBe(0.4);
	});

	it("clamps at 0", () => {
		expect(applyDecay(0.3, -0.9)).toBe(0);
	});

	it("rounds to 2 decimal places", () => {
		expect(applyDecay(0.55, -0.1)).toBe(0.45);
	});

	it("keeps confidence if delta is 0", () => {
		expect(applyDecay(0.5, 0)).toBe(0.5);
	});
});

describe("findMemoryFile", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_find_${Date.now()}`;
		const { MEMORIES_ROOT } = await import("../constants.ts");

		// Cria uma memória numa localização específica
		const fp = join(MEMORIES_ROOT, "_global", "gotchas", "findme.md");
		ensureFileDir(fp);
		writeFileSync(fp, "---\ncontext: findme\ntype: gotchas\nconfidence: 0.6\n---\n\ncontent");

		// Memória com escopo de projeto
		const pfp = join(MEMORIES_ROOT, "projects", testProjectId, "_rules", "projrule.md");
		ensureFileDir(pfp);
		writeFileSync(pfp, "---\ncontext: projrule\ntype: _rules\nconfidence: 0.7\n---\n\ncontent");
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../constants.ts");
		rmSync(join(MEMORIES_ROOT, "_global", "gotchas", "findme.md"), { force: true });
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
	});

	it("finds global memory by context", () => {
		const fp = findMemoryFile("__test_find_20250101", "findme");
		expect(fp).toBeDefined();
		expect(fp!).toContain("_global");
		expect(fp!).toContain("gotchas");
	});

	it("finds project memory by context", () => {
		const fp = findMemoryFile(testProjectId, "projrule");
		expect(fp).toBeDefined();
		expect(fp!).toContain("projects");
		expect(fp!).toContain("projrule");
	});

	it("returns undefined for unknown context", () => {
		expect(findMemoryFile("whatever", "does-not-exist-xyz")).toBeUndefined();
	});
});

describe("moveToSupersedes", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_move_${Date.now()}`;
		const { MEMORIES_ROOT } = await import("../constants.ts");

		const fp = join(MEMORIES_ROOT, "_global", "_rules", "decayme.md");
		ensureFileDir(fp);
		writeFileSync(
			fp,
			[
				"---",
				"context: decayme",
				"type: _rules",
				"confidence: 0.6",
				"---",
				"",
				"## [2025-01-01] Old rule",
				"",
				"Some content here.",
			].join("\n"),
		);
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../constants.ts");
		rmSync(join(MEMORIES_ROOT, "_global", "_rules", "decayme.md"), { force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "_global", "_rules", "decayme.md"), { force: true });
	});

	it("moves file to .supersedes preserving structure", async () => {
		const { MEMORIES_ROOT } = await import("../constants.ts");

		const original = join(MEMORIES_ROOT, "_global", "_rules", "decayme.md");
		const supPath = moveToSupersedes(original, { superseded_reason: "test decay" });

		// Original removed
		expect(existsSync(original)).toBeFalse();

		// Arquivo novo existe na localização esperada
		expect(supPath).toBe(join(MEMORIES_ROOT, ".supersedes", "_global", "_rules", "decayme.md"));
		expect(existsSync(supPath)).toBeTrue();

		// Conteúdo preservado com metadados
		const content = readFileSync(supPath, "utf-8");
		expect(content).toContain("context: \"decayme\"");
		expect(content).toContain("superseded_at:");
		expect(content).toContain("superseded_reason: \"test decay\"");
		expect(content).toContain("confidence: 0");
		expect(content).toContain("## [2025-01-01] Old rule");
	});
});

describe("saveMemory (shared by memory_save/memory_extract)", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_savemem_${Date.now()}`;
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../constants.ts");
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".history", "projects", testProjectId), { recursive: true, force: true });
		// "supersedes across different type and scope" cria cache-rule em
		// _global/_rules e move para .supersedes — limpa o resíduo global
		rmSync(join(MEMORIES_ROOT, ".supersedes", "_global", "_rules", "cache-rule.md"), { force: true });
	});

	it("creates a new memory file", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "test-ctx",
			title: "Test memory",
			content: "Some rich content",
			scope: "project",
			confidence: 0.7,
		});

		expect(result.action).toBe("created");
		expect(result.gitPaths).toContain(result.file);
		expect(existsSync(result.file)).toBeTrue();

		const content = readFileSync(result.file, "utf-8");
		expect(content).toContain("context: \"test-ctx\"");
		expect(content).toContain("# Test memory"); // snapshot v2 (título no corpo)
		expect(content).toContain("revision: 1");
		expect(content).toContain("Some rich content");
	});

	it("rejects non-canonical type without creating a directory", () => {
		const result = saveMemory(testProjectId, {
			type: "gotcha", // singular — would create the wrong directory
			context: "bad-type",
			title: "T",
			content: "C",
			scope: "project",
		});

		expect(result.action).toBe("error");
		expect(result.error).toBeDefined();

		// Nenhum diretório no singular deveria ter sido criado
		const bogusDir = join(MEMORIES_ROOT, "projects", testProjectId, "gotcha");
		expect(existsSync(bogusDir)).toBeFalse();
	});

	it("reescreve snapshot ao salvar de novo (append legado = consolidate)", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "test-ctx",
			title: "Segunda versão",
			content: "Conteúdo novo",
			scope: "project",
			confidence: 0.6,
		});

		expect(result.action).toBe("consolidated");
		expect(result.revision).toBe(2);

		const content = readFileSync(result.file, "utf-8");
		expect(content).toContain("# Segunda versão");
		expect(content).toContain("Conteúdo novo");
		expect(content).not.toContain("Some rich content");

		// Versão anterior arquivada em .history/ (não mais acumulada no ativo)
		const histPath = join(
			MEMORIES_ROOT,
			".history",
			"projects",
			testProjectId,
			"gotchas",
			"test-ctx",
			"v1.md",
		);
		expect(existsSync(histPath)).toBeTrue();
		expect(result.gitPaths).toContain(histPath);
	});

	it("snapshot: confiança é a da última escrita; .history/ acumula revisões", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "multi-avg",
			title: "Primeira",
			content: "content",
			scope: "project",
			confidence: 0.7,
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "multi-avg",
			title: "Segunda",
			content: "content",
			scope: "project",
			confidence: 0.6,
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "multi-avg",
			title: "Terceira",
			content: "content",
			scope: "project",
			confidence: 0.5,
		});

		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "multi-avg.md");
		const { meta } = parseFrontmatter(readFileSync(fp, "utf-8"));
		expect(meta.confidence).toBe(0.5); // decisão da última versão (não média)
		expect(meta.revision).toBe(3);
		expect(
			existsSync(join(MEMORIES_ROOT, ".history", "projects", testProjectId, "gotchas", "multi-avg", "v2.md")),
		).toBeTrue();
	});

	it("nova escrita substitui confiança decayed (snapshot)", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-multi",
			title: "Primeira",
			content: "content",
			scope: "project",
			confidence: 0.7,
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-multi",
			title: "Segunda",
			content: "content",
			scope: "project",
			confidence: 0.6,
		});

		// Simula decay: reduz a confiança do frontmatter para 0.3
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "decay-multi.md");
		const { meta, body } = parseFrontmatter(readFileSync(fp, "utf-8"));
		meta.confidence = 0.3;
		writeFileSync(fp, formatFrontmatter(meta) + body);

		// Nova versão decide a própria confiança — decay não vaza pela média
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-multi",
			title: "Terceira",
			content: "content",
			scope: "project",
			confidence: 0.5,
		});

		const updated = readFileSync(fp, "utf-8");
		const { meta: meta2 } = parseFrontmatter(updated);
		expect(meta2.confidence).toBe(0.5);
		expect(meta2.revision).toBe(3);
	});

	it("reescrita substitui confiança decayed no snapshot", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-persist",
			title: "Primeira",
			content: "content",
			scope: "project",
			confidence: 0.7,
		});
		expect(result.action).toBe("created");

		// Simula decay: reduz a confiança do frontmatter para 0.4
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "decay-persist.md");
		const { meta, body } = parseFrontmatter(readFileSync(fp, "utf-8"));
		meta.confidence = 0.4;
		writeFileSync(fp, formatFrontmatter(meta) + body);

		// Nova versão com 0.5 — snapshot usa a confiança da nova versão
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-persist",
			title: "Segunda",
			content: "more",
			scope: "project",
			confidence: 0.5,
		});

		const updated = readFileSync(fp, "utf-8");
		const { meta: meta2 } = parseFrontmatter(updated);
		expect(meta2.confidence).toBe(0.5);
		expect(meta2.revision).toBe(2);
	});

	it("handles supersedes", async () => {
		// Cria uma memória superseded primeiro
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "old-ctx",
			title: "Old info",
			content: "Outdated",
			scope: "project",
		});

		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "new-ctx",
			title: "New info",
			content: "Better",
			scope: "project",
			supersedes: "old-ctx",
		});

		expect(result.action).toBe("created");

		// O arquivo antigo deve estar em .supersedes agora
		const { MEMORIES_ROOT } = await import("../constants.ts");
		const supPath = join(
			MEMORIES_ROOT,
			".supersedes",
			"projects",
			testProjectId,
			"gotchas",
			"old-ctx.md",
		);
		expect(existsSync(supPath)).toBeTrue();
	});

	it("supersedes across different type and scope", async () => {
		// A memória antiga vive em _global/_rules (tipo+escopo diferentes do novo save)
		saveMemory(testProjectId, {
			type: "_rules",
			context: "cache-rule",
			title: "Regra antiga",
			content: "Cache deve ser invalidado manualmente",
			scope: "global",
		});

		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "cache-gotcha",
			title: "Gotcha novo",
			content: "Cache invalida sozinho",
			scope: "project",
			supersedes: "cache-rule",
		});

		expect(result.action).toBe("created");

		// O arquivo antigo deve estar em .supersedes com estrutura _global/_rules
		const { MEMORIES_ROOT } = await import("../constants.ts");
		const supPath = join(
			MEMORIES_ROOT,
			".supersedes",
			"_global",
			"_rules",
			"cache-rule.md",
		);
		expect(existsSync(supPath)).toBeTrue();

		// O original deve ter sumido
		expect(existsSync(join(MEMORIES_ROOT, "_global", "_rules", "cache-rule.md"))).toBeFalse();
	});

	it("consolidates existing memory (mode=consolidate)", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "consol-ctx",
			title: "v1",
			content: "conteúdo antigo",
			scope: "project",
			confidence: 0.7,
		});
		expect(result.action).toBe("created");

		const consolidated = saveMemory(testProjectId, {
			type: "gotchas",
			context: "consol-ctx",
			title: "v2",
			content: "conteúdo consolidado novo",
			scope: "project",
			confidence: 0.8,
		});

		expect(consolidated.action).toBe("consolidated");

		// Arquivo novo: conteúdo v2, snapshot com revision, confiança da versão
		const content = readFileSync(consolidated.file, "utf-8");
		expect(content).toContain("# v2");
		expect(content).toContain("conteúdo consolidado novo");
		expect(content).not.toContain("conteúdo antigo");
		expect(content).toContain("revision: 2");
		expect(content).toContain("confidence: 0.8");

		// Versão antiga arquivada em .history/ com metadados
		const histPath = join(
			MEMORIES_ROOT,
			".history",
			"projects",
			testProjectId,
			"gotchas",
			"consol-ctx",
			"v1.md",
		);
		expect(existsSync(histPath)).toBeTrue();
		const histContent = readFileSync(histPath, "utf-8");
		expect(histContent).toContain("conteúdo antigo");
		expect(histContent).toContain("superseded_by: \"consol-ctx\"");
		expect(histContent).toContain("superseded_reason: \"consolidated\"");
	});

	it("consolidate on non-existent context creates normally", () => {
		const result = saveMemory(testProjectId, {
			type: "lessons",
			context: "consol-new",
			title: "t",
			content: "c",
			scope: "project",
		});
		expect(result.action).toBe("created");
	});

	it("consolidate respects invalid type guard", () => {
		const result = saveMemory(testProjectId, {
			type: "gotcha", // singular inválido
			context: "consol-bad",
			title: "t",
			content: "c",
			scope: "project",
		});
		expect(result.action).toBe("error");
	});
});

describe("saveMemory archived (supersedes/consolidate)", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_archived_${Date.now()}`;
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../constants.ts");
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "projects", testProjectId), {
			recursive: true,
			force: true,
		});
		rmSync(join(MEMORIES_ROOT, ".history", "projects", testProjectId), { recursive: true, force: true });
	});

	it("supersedes entre contextos retorna o path ativo arquivado", () => {
		const a = saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-a",
			title: "A",
			content: "conteúdo A",
			scope: "project",
		});
		saveMemory(testProjectId, {
			type: "lessons",
			context: "arch-b",
			title: "B",
			content: "conteúdo B",
			scope: "project",
		});

		// B supersede A (cross-type dentro do mesmo projeto — findMemoryFile
		// procura em todos os tipos/escopos).
		const r = saveMemory(testProjectId, {
			type: "lessons",
			context: "arch-b",
			title: "B2",
			content: "conteúdo B novo",
			scope: "project",
			supersedes: "arch-a",
		});

		expect(r.action).toBe("consolidated"); // arch-b já existia → reescrita
		expect(r.archived).toHaveLength(2); // arch-a → .supersedes/; arch-b → .history/
		expect(r.archived[0]).toBe(a.file);
		expect(existsSync(a.file)).toBeFalse(); // movido para .supersedes/
	});

	it("consolidate arquiva o MESMO path e o recria", () => {
		const c = saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-c",
			title: "C",
			content: "versão 1",
			scope: "project",
		});

		const r = saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-c",
			title: "C2",
			content: "versão 2",
			scope: "project",
		});

		expect(r.action).toBe("consolidated");
		expect(r.archived).toHaveLength(1);
		expect(r.archived[0]).toBe(c.file); // mesmo path arquivado e recriado
		expect(existsSync(c.file)).toBeTrue(); // recriado ativo
	});

	it("escrita atômica não deixa resíduo .tmp (create + consolidate)", () => {
		const dir = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas");
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-atomic-clean",
			title: "V1",
			content: "versão 1",
			scope: "project",
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-atomic-clean",
			title: "V2",
			content: "versão 2",
			scope: "project",
		});
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});

	it("falha de escrita não destrói o snapshot ativo (atômico)", () => {
		const created = saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-atomic-fail",
			title: "V1",
			content: "versão 1",
			scope: "project",
		});
		const dir = dirname(created.file);
		chmodSync(dir, 0o555); // diretório somente leitura → escrita do .tmp falha
		try {
			expect(() =>
				saveMemory(testProjectId, {
					type: "gotchas",
					context: "arch-atomic-fail",
					title: "V2",
					content: "versão 2",
					scope: "project",
				}),
			).toThrow();
		} finally {
			chmodSync(dir, 0o755);
		}
		// Snapshot ativo INTACTO com o conteúdo antigo — a escrita nova falhou
		// no .tmp e nada do ativo foi tocado; sem resíduo .tmp.
		expect(readFileSync(created.file, "utf-8")).toContain("versão 1");
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});

	it("context existente em OUTRO type/scope é arquivado (unicidade de key)", () => {
		const first = saveMemory(testProjectId, {
			type: "lessons",
			context: "arch-moved",
			title: "L",
			content: "lição antiga",
			scope: "project",
		});

		// Reescrita com type divergente (lessons → decisions): a versão antiga
		// em outro path NÃO pode permanecer ativa — arquiva em .history/.
		const r = saveMemory(testProjectId, {
			type: "decisions",
			context: "arch-moved",
			title: "D",
			content: "decisão nova",
			scope: "project",
		});

		expect(r.archived).toContain(first.file); // antiga arquivada
		expect(existsSync(first.file)).toBeFalse();
		// Só UMA memória ativa com a key — e é a do novo path.
		expect(findMemoryFile(testProjectId, "arch-moved")).toBe(r.file);
		expect(r.file).toContain("/decisions/arch-moved.md");
	});

	it("create retorna archived vazio; reescrita arquiva em .history/", () => {
		const created = saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-plain",
			title: "P",
			content: "conteúdo",
			scope: "project",
		});
		expect(created.archived).toEqual([]);

		const rewritten = saveMemory(testProjectId, {
			type: "gotchas",
			context: "arch-plain",
			title: "P2",
			content: "mais",
			scope: "project",
		});
		expect(rewritten.action).toBe("consolidated");
		expect(rewritten.archived).toEqual([created.file]); // mesmo path → .history/
	});

	it("erro (tipo inválido) retorna archived vazio", () => {
		const err = saveMemory(testProjectId, {
			type: "gotcha",
			context: "arch-bad",
			title: "T",
			content: "C",
			scope: "project",
		});
		expect(err.action).toBe("error");
		expect(err.archived).toEqual([]);
	});
});

describe("migração v1 → snapshot v2", () => {
	const proj = "test_project";
	const legacyDir = join(MEMORIES_ROOT, "projects", proj, "gotchas");

	afterAll(() => {
		// Limpa o que o teste cria no ROOT REAL de memórias (projeto + arquivos
		// migrados em .history/) — teste não pode poluir produção.
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".history", "projects", proj), { recursive: true, force: true });
	});

	function writeV1(context: string): string {
		const fp = join(legacyDir, `${context}.md`);
		const v1 =
			'---\ncontext: "' + context + '"\ntype: "gotchas"\ncreated: "2026-01-01"\nconfidence: 0.7\n---\n' +
			"## [2026-01-01] Bug antigo\nconfidence: 0.7\n\nO cache era invalidado depois da leitura.\n" +
			"## [2026-02-01] Bug corrigido\nconfidence: 0.8\n\nA invalidação agora acontece antes da leitura.\n";
		writeFileSync(fp, v1);
		return fp;
	}

	it("converte v1 em snapshot v2 com a última entrada e arquiva em .history/v0", () => {
		ensureDirectories(proj);
		const fp = writeV1("legacy-mig");

		expect(migrateMemoryToSnapshot(fp)).toBeTrue();

		const raw = readFileSync(fp, "utf-8");
		const { meta, body } = parseFrontmatter(raw);
		expect(meta.revision).toBe(1);
		expect(meta.scope).toBe("project");
		expect(body.startsWith("# Bug corrigido")).toBeTrue();
		expect(body).not.toContain("Bug antigo");

		// Baseline arquivada em .history/projects/test_project/gotchas/legacy-mig/v0.md
		const hist = join(
			MEMORIES_ROOT, ".history", "projects", proj, "gotchas", "legacy-mig", "v0.md",
		);
		expect(existsSync(hist)).toBeTrue();
		expect(readFileSync(hist, "utf-8")).toContain("Bug antigo");
		expect(findMemoryFile(proj, "legacy-mig")).toBe(fp);
	});

	it("idempotente: v2 não é re-migrado", () => {
		const fp = writeV1("legacy-mig2");
		expect(migrateMemoryToSnapshot(fp)).toBeTrue();
		expect(migrateMemoryToSnapshot(fp)).toBeFalse(); // já v2
	});

	it("migrateLegacyMemories varre global + projeto e é idempotente", () => {
		ensureDirectories(proj);
		// Arquivo v1 novo + outros já v2 não devem ser recontados.
		const fp = writeV1("legacy-scan");
		const n = migrateLegacyMemories(proj);
		expect(n).toBeGreaterThanOrEqual(1);
		expect(migrateLegacyMemories(proj)).toBe(0); // tudo já v2
		expect(existsSync(fp)).toBeTrue();
		const { meta } = parseFrontmatter(readFileSync(fp, "utf-8"));
		expect(meta.revision).toBe(1);
	});
});

describe("saveMemory summary", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_summary_${Date.now()}`;
	});

	afterAll(async () => {
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		// O teste mode:consolidate move sum-cons.md para .supersedes —
		// limpa o resíduo também (senão todo teste vaza um artefato).
		rmSync(join(MEMORIES_ROOT, ".supersedes", "projects", testProjectId), {
			recursive: true,
			force: true,
		});
		rmSync(join(MEMORIES_ROOT, ".history", "projects", testProjectId), { recursive: true, force: true });
	});

	it("stores summary in frontmatter on create", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "sum-ctx",
			title: "t",
			content: "conteúdo",
			scope: "project",
			summary: "Resumo do estado atual",
		});
		const content = readFileSync(
			join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "sum-ctx.md"),
			"utf-8",
		);
		expect(content).toContain('summary: "Resumo do estado atual"');
	});

	it("overwrites summary on append", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "sum-ctx",
			title: "t2",
			content: "mais conteúdo",
			scope: "project",
			summary: "Resumo atualizado após append",
		});
		const content = readFileSync(
			join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "sum-ctx.md"),
			"utf-8",
		);
		expect(content).toContain('summary: "Resumo atualizado após append"');
		expect(content).not.toContain('summary: "Resumo do estado atual"');
	});

	it("keeps previous summary when append omits it", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "sum-ctx",
			title: "t3",
			content: "sem summary novo",
			scope: "project",
		});
		const content = readFileSync(
			join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "sum-ctx.md"),
			"utf-8",
		);
		expect(content).toContain('summary: "Resumo atualizado após append"');
	});

	it("stores summary on consolidate (fresh file)", () => {
		saveMemory(testProjectId, {
			type: "lessons",
			context: "sum-cons",
			title: "v1",
			content: "antigo",
			scope: "project",
			summary: "antigo resumo",
		});
		const result = saveMemory(testProjectId, {
			type: "lessons",
			context: "sum-cons",
			title: "v2",
			content: "novo",
			scope: "project",
			summary: "resumo consolidado",
		});
		expect(result.action).toBe("consolidated");
		const content = readFileSync(result.file, "utf-8");
		expect(content).toContain('summary: "resumo consolidado"');
		expect(content).not.toContain("antigo resumo");
	});
});

describe("listMemoryIndex", () => {
	let testProjectId: string;

	beforeAll(() => {
		testProjectId = `__test_index_${Date.now()}`;
		// 2 global + 2 projeto, datas de updated diferentes, 1 com summary
		ensureFileDir(join(MEMORIES_ROOT, "_global", "gotchas", "old-global.md"));
		writeFileSync(
			join(MEMORIES_ROOT, "_global", "gotchas", "old-global.md"),
			"---\ncontext: old-global\ntype: gotchas\nconfidence: 0.6\nupdated: 2026-01-01\n---\n\n## [2026-01-01 10:00:00] Global antiga\n\nconteúdo antigo\n",
		);
		ensureFileDir(join(MEMORIES_ROOT, "_global", "_rules", "new-global.md"));
		writeFileSync(
			join(MEMORIES_ROOT, "_global", "_rules", "new-global.md"),
			"---\ncontext: new-global\ntype: _rules\nconfidence: 0.9\nupdated: 2026-08-05\nsummary: \"Resumo global\"\n---\n\n## [2026-08-05 10:00:00] Global nova\n\nconteúdo novo\n",
		);
		ensureFileDir(join(MEMORIES_ROOT, "projects", testProjectId, "lessons", "proj-a.md"));
		writeFileSync(
			join(MEMORIES_ROOT, "projects", testProjectId, "lessons", "proj-a.md"),
			"---\ncontext: proj-a\ntype: lessons\nconfidence: 0.7\nupdated: 2026-07-15\n---\n\n## [2026-07-15 10:00:00] Lição A\n\nlição A\n",
		);
		ensureFileDir(join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "proj-b.md"));
		writeFileSync(
			join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "proj-b.md"),
			"---\ncontext: proj-b\ntype: gotchas\nconfidence: 0.5\nupdated: 2026-05-20\n---\n\n## [2026-05-20 10:00:00] Gotcha B\n\n" + "y".repeat(300) + "\n",
		);
	});

	afterAll(() => {
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, "_global", "gotchas", "old-global.md"), { force: true });
		rmSync(join(MEMORIES_ROOT, "_global", "_rules", "new-global.md"), { force: true });
	});

	it("lists all memories with metadata (global + project)", () => {
		const entries = listMemoryIndex(testProjectId);
		const mine = entries.filter((e) =>
			["new-global", "old-global", "proj-a", "proj-b"].includes(e.context),
		);
		expect(mine).toHaveLength(4);
		const byContext = Object.fromEntries(mine.map((e) => [e.context, e]));
		expect(byContext["new-global"].scope).toBe("global");
		expect(byContext["new-global"].type).toBe("_rules");
		expect(byContext["new-global"].confidence).toBe(0.9);
		expect(byContext["new-global"].title).toBe("Global nova");
		expect(byContext["new-global"].summary).toBe("Resumo global");
		expect(byContext["proj-a"].scope).toBe("project");
		expect(byContext["proj-b"].excerpt.length).toBeLessThan(300);
	});

	it("sorts by updated desc", () => {
		const entries = listMemoryIndex(testProjectId);
		const mine = entries.filter((e) =>
			["new-global", "old-global", "proj-a", "proj-b"].includes(e.context),
		);
		expect(mine[0].context).toBe("new-global"); // 2026-08-05
		expect(mine[1].context).toBe("proj-a"); // 2026-07-15
		expect(mine[2].context).toBe("proj-b"); // 2026-05-20
		expect(mine[3].context).toBe("old-global"); // 2026-01-01
	});
});

describe("formatMemoryIndexText", () => {
	it("shows total, recent, rest by scope and full counts (never omits 0)", () => {
		const entries: MemoryIndexEntry[] = [];
		for (let i = 1; i <= 20; i++) {
			entries.push({
				scope: i % 2 === 0 ? "project" : "global",
				type: MEMORY_TYPES[i % MEMORY_TYPES.length],
				context: `ctx-${i}`,
				title: `Título ${i}`,
				confidence: 0.5 + (i % 4) * 0.1,
				updated: `2026-07-${String(i).padStart(2, "0")}`,
				excerpt: "",
			});
		}
		const text = formatMemoryIndexText(entries);
		expect(text).toContain("total: 20");
		expect(text).toContain("Most recent 15:");
		// 15 recentes + 5 restantes
		expect(text).toContain("ctx-1"); // mais recente (updated 07-20)
		expect(text).toContain("5 not shown");
		expect(text).toContain("Counts by scope (all):");
		expect(text).toContain("_global: ");
		expect(text).toContain("project: ");
		// nunca omite tipos com 0
		expect(text).toContain("(0 memories)");
		// ordem fixa de tipos
		const gl = text.match(/_global: (.*)/)![1];
		const types = gl.split(", ").map((s) => s.split(" ")[0]);
		expect(types).toEqual(["_rules", "decisions", "gotchas", "lessons", "patterns"]);
	});

	it("handles empty index (still injects, with zeros)", () => {
		const text = formatMemoryIndexText([]);
		expect(text).toContain("total: 0");
		expect(text).toContain("(none yet");
		expect(text).toContain("Counts by scope (all):");
		expect(text).toContain("_global: _rules (0 memories)");
		expect(text).toContain("project: _rules (0 memories)");
		expect(text).not.toContain("not shown");
	});

	it("omits rest block when total <= 15", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			scope: "project" as const,
			type: "gotchas" as const,
			context: `c${i}`,
			title: `T${i}`,
			confidence: 0.5,
			updated: `2026-07-${String(i + 1).padStart(2, "0")}`,
			excerpt: "",
		}));
		const text = formatMemoryIndexText(entries);
		expect(text).not.toContain("not shown");
		expect(text).toContain("Counts by scope (all):");
	});
});


describe("getMemoryStats", () => {
	const proj = `stats-test-${Date.now()}`;

	afterAll(() => {
		const dir = join(MEMORIES_ROOT, "projects", proj);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		// cleanup do arquivo criado em _global (nome único do teste)
		const globalPatterns = join(MEMORIES_ROOT, "_global", "patterns");
		if (existsSync(globalPatterns)) {
			for (const f of readdirSync(globalPatterns)) {
				if (f.endsWith("stats-test-global.md")) {
					rmSync(join(globalPatterns, f), { force: true });
				}
			}
		}
	});

	it("conta arquivos .md ativos por escopo (exclui .supersedes/.history)", () => {
		// 2 memórias no projeto + 1 global de teste
		for (const [type, name] of [
			["gotchas", "stats-test-a"],
			["decisions", "stats-test-b"],
		] as const) {
			const dir = join(MEMORIES_ROOT, "projects", proj, type);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${name}.md`), "---\ntype: gotchas\n---\nbody");
		}
		const globalDir = join(MEMORIES_ROOT, "_global", "patterns");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "stats-test-global.md"), "---\ntype: patterns\n---\nbody");

		// arquivo que NÃO deve contar (fora do layout ativo)
		mkdirSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", ".supersedes"), { recursive: true });
		writeFileSync(
			join(MEMORIES_ROOT, "projects", proj, "gotchas", ".supersedes", "stats-test-c.md"),
			"---\ntype: gotchas\n---\nbody",
		);

		const stats = getMemoryStats(proj);
		expect(stats.project).toBe(2);
		expect(stats.global).toBeGreaterThanOrEqual(1); // pode haver memórias globais reais do usuário
		expect(stats.total).toBe(stats.global + stats.project);
	});

	it("retorna project zerado para projeto sem diretórios (global preserva memórias reais)", () => {
		const stats = getMemoryStats(`stats-empty-${Date.now()}`);
		expect(stats.project).toBe(0);
		expect(stats.total).toBe(stats.global);
	});
});
