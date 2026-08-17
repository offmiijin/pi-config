/**
 * pi-memory — Tests: frontmatter v3 (memory_id, retention_policy).
 *
 * saveMemory gera/preserva identidade estável; ensureMemoryIdentities migra
 * arquivos v2 sem perturbar updated/confidence. Fixtures no MEMORIES_ROOT
 * real sob projeto temporário (mesmo padrão de memory.test.ts).
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MEMORIES_ROOT } from "../constants.ts";
import { ensureFileDir } from "../session.ts";
import { ensureMemoryIdentities, parseFrontmatter, saveMemory } from "../memory/memory.ts";

describe("frontmatter v3 — saveMemory", () => {
	let proj: string;
	let dbDir: string;

	beforeAll(() => {
		proj = `__test_ret_v3_${Date.now()}`;
		dbDir = mkdtempSync(join(tmpdir(), "ret-v3-"));
	});

	afterAll(() => {
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	function readMeta(context: string, type = "gotchas"): { meta: Record<string, unknown> } {
		const fp = join(MEMORIES_ROOT, "projects", proj, type, `${context}.md`);
		return parseFrontmatter(readFileSync(fp, "utf-8"));
	}

	it("criação nova gera memory_id e política default por tipo", () => {
		saveMemory(proj, {
			type: "gotchas",
			context: "cache-v3",
			title: "Cache",
			content: "Bug no cache.",
			scope: "project",
		});
		const { meta } = readMeta("cache-v3");
		expect(typeof meta.memory_id).toBe("string");
		expect(meta.memory_id).not.toBe("");
		expect(meta.retention_policy).toBe("normal");
	});

	it("_rules default → protected", () => {
		saveMemory(proj, {
			type: "_rules",
			context: "regra-v3",
			title: "Regra",
			content: "Sempre X.",
			scope: "project",
		});
		const { meta } = readMeta("regra-v3", "_rules");
		expect(meta.retention_policy).toBe("protected");
	});

	it("override explícito de retention_policy é respeitado", () => {
		saveMemory(proj, {
			type: "gotchas",
			context: "prot-v3",
			title: "Prot",
			content: "Coisa protegida.",
			scope: "project",
			retention_policy: "protected",
		});
		const { meta } = readMeta("prot-v3");
		expect(meta.retention_policy).toBe("protected");
	});

	it("consolidação preserva memory_id e política", () => {
		const first = readMeta("cache-v3").meta;
		saveMemory(proj, {
			type: "gotchas",
			context: "cache-v3",
			title: "Cache v2",
			content: "Bug corrigido.",
			scope: "project",
		});
		const { meta } = readMeta("cache-v3");
		expect(meta.memory_id).toBe(first.memory_id);
		expect(meta.retention_policy).toBe("normal");
	});

	it("contexto movido de tipo carrega memory_id (continuidade de uso)", () => {
		const before = readMeta("cache-v3").meta;
		saveMemory(proj, {
			type: "lessons",
			context: "cache-v3",
			title: "Cache lesson",
			content: "Lição do cache.",
			scope: "project",
		});
		const { meta } = readMeta("cache-v3", "lessons");
		expect(meta.memory_id).toBe(before.memory_id);
	});
});

describe("frontmatter v3 — ensureMemoryIdentities", () => {
	let proj: string;

	beforeAll(() => {
		proj = `__test_ret_mig_${Date.now()}`;
	});

	afterAll(() => {
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
	});

	it("arquivo v2 recebe memory_id e política sem tocar updated/confidence", () => {
		const fp = join(MEMORIES_ROOT, "projects", proj, "gotchas", "legacy.md");
		ensureFileDir(fp);
		writeFileSync(
			fp,
			[
				"---",
				'context: legacy',
				'type: gotchas',
				'scope: project',
				'revision: 1',
				'created: "2025-06-01"',
				'updated: "2025-06-01"',
				'confidence: 0.7',
				"---",
				"",
				"# Legado",
				"",
				"Memória antiga.",
				"",
			].join("\n"),
		);

		const n = ensureMemoryIdentities(proj);
		expect(n).toBe(1);

		const content = readFileSync(fp, "utf-8");
		const { meta } = parseFrontmatter(content);
		expect(typeof meta.memory_id).toBe("string");
		expect(meta.retention_policy).toBe("normal");
		expect(meta.updated).toBe("2025-06-01"); // intocado
		expect(meta.confidence).toBe(0.7); // intocado
	});

	it("idempotente: segunda chamada não altera nada", () => {
		const n = ensureMemoryIdentities(proj);
		expect(n).toBe(0);
	});
});
