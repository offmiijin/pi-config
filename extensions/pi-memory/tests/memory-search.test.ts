/**
 * pi-memory — Tests: memory-search.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	MAX_MEMORY_SEARCH_ATTEMPTS,
	MEMORIES_ROOT
} from "../constants.ts";

import {
	ensureFileDir
} from "../session.ts";

import {
	buildSearchPattern,
	readFileConfidence,
	searchMemories
} from "../memory/memory-search.ts";

describe("readFileConfidence", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-rfc-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined for non-existent file", () => {
		expect(readFileConfidence(join(tmpDir, "none.md"))).toBeUndefined();
	});

	it("returns confidence from frontmatter", () => {
		const fp = join(tmpDir, "test.md");
		writeFileSync(fp, "---\nconfidence: 0.7\n---\n\ncontent");
		expect(readFileConfidence(fp)).toBe(0.7);
	});

	it("returns undefined when no confidence in frontmatter", () => {
		const fp = join(tmpDir, "noconf.md");
		writeFileSync(fp, "---\ncontext: test\n---\n\ncontent");
		expect(readFileConfidence(fp)).toBeUndefined();
	});

	it("returns undefined for file without frontmatter", () => {
		const fp = join(tmpDir, "plain.md");
		writeFileSync(fp, "# just content");
		expect(readFileConfidence(fp)).toBeUndefined();
	});
});

describe("buildSearchPattern", () => {
	it("joins terms with | (OR semantics)", () => {
		expect(buildSearchPattern(["cache", "invalidation"])).toBe("cache|invalidation");
	});

	it("escapes regex metacharacters for literal matching", () => {
		expect(buildSearchPattern(["C++", "a.b"])).toBe("C\\+\\+|a\\.b");
	});

	it("filters empty and whitespace-only terms", () => {
		expect(buildSearchPattern(["", "foo", " "])).toBe("foo");
	});

	it("returns empty string for empty input", () => {
		expect(buildSearchPattern([])).toBe("");
	});
});

describe("MAX_MEMORY_SEARCH_ATTEMPTS", () => {
	it("is 3", () => {
		expect(MAX_MEMORY_SEARCH_ATTEMPTS).toBe(3);
	});
});

describe("searchMemories", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_search_${Date.now()}`;
		const { MEMORIES_ROOT } = await import("../constants.ts");

		// Escreve um arquivo de teste no MEMORIES_ROOT real sob projeto temporário
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "test-memory.md");
		ensureFileDir(fp);
		writeFileSync(
			fp,
			[
				"---",
				"context: test-memory",
				"type: gotchas",
				"confidence: 0.7",
				"---",
				"",
				"## [2025-01-15] Test Memory",
				"confidence: 0.7",
				"",
				"This is a test memory about unicorns and rainbows.",
			].join("\n"),
		);

		// Também um arquivo global
		const globalFp = join(MEMORIES_ROOT, "_global", "_rules", "test-global.md");
		ensureFileDir(globalFp);
		writeFileSync(
			globalFp,
			[
				"---",
				"context: test-global",
				"type: _rules",
				"confidence: 0.8",
				"---",
				"",
				"## [2025-01-10] Global Rule",
				"",
				"Always test memory search functions.",
			].join("\n"),
		);

		// Arquivo de sessão com palavra-chave única (não deve aparecer nos resultados)
		const sessionFp = join(
			MEMORIES_ROOT,
			"projects",
			testProjectId,
			"sessions",
			"2026-08-02",
			"sesstest-hash.md",
		);
		ensureFileDir(sessionFp);
		writeFileSync(
			sessionFp,
			'# Session sesstest\n\n## Obs #1\nUser: "busca-session-exclusiva-xyz"\n',
		);
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../constants.ts");
		const testDir = join(MEMORIES_ROOT, "projects", testProjectId);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

		const globalFile = join(MEMORIES_ROOT, "_global", "_rules", "test-global.md");
		if (existsSync(globalFile)) rmSync(globalFile);
	});

	it("returns empty array for non-matching query", () => {
		const results = searchMemories({
			query: "zzzxyznonexistent_12345",
			projectId: testProjectId,
			limit: 5,
		});
		expect(results).toEqual([]);
	});

	it("finds by keyword in all scopes", () => {
		const results = searchMemories({ query: "unicorns", projectId: testProjectId, limit: 10 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		const match = results.find((r) => r.file.includes("test-memory.md"));
		expect(match).toBeDefined();
		expect(match!.lines.some((l) => l.includes("unicorns"))).toBeTrue();
	});

	it("filters by scope=global", () => {
		const results = searchMemories({ query: "test-global", scope: "global", limit: 10 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		for (const r of results) {
			expect(r.file).toContain("_global");
		}
	});

	it("filters by scope=project", () => {
		const results = searchMemories({
			query: "unicorns",
			scope: "project",
			projectId: testProjectId,
			limit: 10,
		});
		expect(results.length).toBeGreaterThanOrEqual(1);
		for (const r of results) {
			expect(r.file).toContain("projects");
		}
	});

	it("filters by type", () => {
		const results = searchMemories({ query: ".*", type: "gotchas", projectId: testProjectId, limit: 10 });
		for (const r of results) {
			expect(r.file).toContain("gotchas");
		}
	});

	it("filters by minConfidence", () => {
		const results = searchMemories({
			query: "unicorns",
			minConfidence: 0.9,
			projectId: testProjectId,
			limit: 10,
		});
		// a memória de teste tem confiança 0.7, então deve ser filtrada
		const match = results.find((r) => r.file.includes("test-memory.md"));
		expect(match).toBeUndefined();
	});

	it("respects limit", () => {
		const results = searchMemories({ query: "test", projectId: testProjectId, limit: 1 });
		expect(results.length).toBeLessThanOrEqual(1);
	});

	it("does not leak memories from other projects in project scope", () => {
		const otherProject = `__test_search_leak_${Date.now()}`;
		const otherFp = join(MEMORIES_ROOT, "projects", otherProject, "gotchas", "leak.md");
		ensureFileDir(otherFp);
		writeFileSync(
			otherFp,
			"---\ncontext: leak\ntype: gotchas\nconfidence: 0.7\n---\n\nunicorns from another project",
		);

		try {
			const results = searchMemories({
				query: "unicorns",
				scope: "project",
				projectId: testProjectId,
				limit: 10,
			});
			const leak = results.find((r) => r.file.includes("leak.md"));
			expect(leak).toBeUndefined();
		} finally {
			rmSync(join(MEMORIES_ROOT, "projects", otherProject), {
				recursive: true,
				force: true,
			});
		}
	});

	it("excludes session files from search", () => {
		const results = searchMemories({
			query: "busca-session-exclusiva-xyz",
			scope: "project",
			projectId: testProjectId,
			limit: 10,
		});
		const match = results.find((r) => r.file.includes("sessions"));
		expect(match).toBeUndefined();
	});

	it("excludes session files from all-scope search", () => {
		const results = searchMemories({
			query: "busca-session-exclusiva-xyz",
			projectId: testProjectId,
			limit: 10,
		});
		expect(results).toEqual([]);
	});

	it("excludes .supersedes/ files", () => {
		const results = searchMemories({
			query: "old memory",
			projectId: testProjectId,
			limit: 10,
		});
		for (const r of results) {
			expect(r.file).not.toContain(".supersedes");
		}
	});

	it("scope=all returns current project + global, never other projects", () => {
		const otherProject = `__test_search_leak_all_${Date.now()}`;
		const otherFp = join(MEMORIES_ROOT, "projects", otherProject, "gotchas", "leak-all.md");
		ensureFileDir(otherFp);
		writeFileSync(
			otherFp,
			"---\ncontext: leak-all\ntype: gotchas\nconfidence: 0.7\n---\n\nunicorns from another project",
		);

		try {
			const results = searchMemories({
				query: "unicorns",
				scope: "all",
				projectId: testProjectId,
				limit: 10,
			});
			// Encontra a memória do projeto atual
			expect(results.some((r) => r.file.includes("test-memory.md"))).toBeTrue();
			// Não vaza a memória de outro projeto
			expect(results.some((r) => r.file.includes("leak-all.md"))).toBeFalse();
		} finally {
			rmSync(join(MEMORIES_ROOT, "projects", otherProject), {
				recursive: true,
				force: true,
			});
		}
	});

	it("throws without projectId for scope=project/all", () => {
		expect(() => searchMemories({ query: "x", scope: "project" })).toThrow(/projectId/);
		expect(() => searchMemories({ query: "x", scope: "all" })).toThrow(/projectId/);
	});
});

