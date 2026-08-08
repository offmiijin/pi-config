/**
 * pi-memory — Tests: tool memory_decay (semântica de falha de índice).
 *
 * Exercita o execute() real da tool com um mock mínimo de ExtensionAPI
 * (registerTool captura a definição) e um MemoryIndex real sobre diretório
 * temporário. Fixtures vivem no MEMORIES_ROOT real sob projeto temporário
 * (mesmo padrão de memory-search.test.ts) porque findMemoryFile/relFromMemoriesRoot
 * operam sobre o root real — tudo é removido no afterAll.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DatabaseCtor } from "../db.ts";

import { MEMORIES_ROOT } from "../constants.ts";
import { ensureFileDir } from "../session.ts";
import { MemoryIndex, relFromMemoriesRoot } from "../memory-index.ts";
import { registerMemoryDecay } from "../tools/decay.ts";
import type { ToolState } from "../tools/state.ts";

interface ToolDef {
	execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

function captureTool(
	register: (pi: unknown, state: ToolState) => void,
	state: ToolState,
): ToolDef {
	let def: ToolDef | null = null;
	const fakePi = {
		registerTool: (d: ToolDef) => {
			def = d;
		},
	};
	register(fakePi, state);
	if (!def) throw new Error("registerTool não capturou a definição");
	return def;
}

function memoryRow(dbPath: string, relPath: string): { confidence: number; content_hash: string } | undefined {
	const probe = new DatabaseCtor(dbPath);
	try {
		const row = probe
			.prepare("SELECT confidence, content_hash FROM memory_documents WHERE path = ?")
			.get(relPath) as { confidence: number; content_hash: string } | undefined;
		return row;
	} finally {
		probe.close();
	}
}

describe("memory_decay — falha de índice não derruba operação", () => {
	let proj: string;
	let dbDir: string;
	let dbPath: string;
	let idx: MemoryIndex;
	const rel = "gotchas/mem.md";
	const relPath = () => `projects/${proj}/gotchas/mem.md`;

	beforeAll(() => {
		proj = `__test_decay_${Date.now()}`;
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-decay-db-"));
		dbPath = join(dbDir, "decay.sqlite");

		// Fixture no MEMORIES_ROOT real (findMemoryFile opera lá)
		const memAbs = join(MEMORIES_ROOT, "projects", proj, "gotchas", "mem.md");
		ensureFileDir(memAbs);
		writeFileSync(memAbs, [
				"---",
				"context: mem",
				"type: gotchas",
				"confidence: 0.8",
				"updated: 2026-08-01",
				"---",
				"",
				"## [2026-08-01 10:00:00] Memória teste",
				"",
				"conteúdo da memória sobre cache.",
			].join("\n"),
		);

		// Índice real sobre root real (db temporário)
		idx = new MemoryIndex(dbPath, MEMORIES_ROOT);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "projects", proj), { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("decay normal sincroniza o índice (confidence + hash) e reporta index=synced", async () => {
		const state: ToolState = {
			projectId: proj,
			currentSessionHash: "",
			lastPromptedBucket: -1,
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: idx,
		};
		const tool = captureTool(registerMemoryDecay, state);
		const beforeHash = memoryRow(dbPath, relPath())?.content_hash;

		const res = await tool.execute("id1", { context: "mem", delta: 0.2 }, undefined, undefined, undefined);
		const text = res.content[0]?.text ?? "";
		expect(text).toContain("from 0.8 to 0.6");
		expect(res.details).toBeDefined();
		expect(res.details!.index).toBe("synced");

		// Markdown canônico atualizado
		const md = readFileSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "mem.md"), "utf-8");
		expect(md).toContain("confidence: 0.6");
		expect(md).toContain('updated: "' + new Date().toISOString().slice(0, 10) + '"');

		// Índice reflete nova confidence e hash novo (reindexação completa)
		const row = memoryRow(dbPath, relPath());
		expect(row!.confidence).toBe(0.6);
		expect(row!.content_hash).not.toBe(beforeHash);
	});

	it("falha do índice degrada e segue: markdown preservado, sem erro", async () => {
		const failingIndex = {
			isOpen: true,
			needsRebuild: false,
			syncMutationSafe: () => ({ ok: false, error: "sqlite locked (simulado)" }),
		} as unknown as MemoryIndex;
		const state: ToolState = {
			projectId: proj,
			currentSessionHash: "",
			lastPromptedBucket: -1,
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: failingIndex,
		};
		const tool = captureTool(registerMemoryDecay, state);

		const res = await tool.execute("id2", { context: "mem", delta: 0.1 }, undefined, undefined, undefined);
		expect(res.details!.index).toBe("degraded");

		// Operação canônica aconteceu MESMO com índice falhando
		const md = readFileSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "mem.md"), "utf-8");
		expect(md).toContain("confidence: 0.5");
	});

	it("supersede com índice falhando: arquivo movido, índice degradado, sem erro", async () => {
		const failingIndex = {
			isOpen: true,
			needsRebuild: false,
			syncMutationSafe: () => ({ ok: false, error: "sqlite locked (simulado)" }),
		} as unknown as MemoryIndex;
		const state: ToolState = {
			projectId: proj,
			currentSessionHash: "",
			lastPromptedBucket: -1,
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: failingIndex,
		};
		const tool = captureTool(registerMemoryDecay, state);

		const res = await tool.execute(
			"id3",
			{ context: "mem", delta: 0.5, move_to_supersedes: true },
			undefined,
			undefined,
			undefined,
		);
		expect(res.details!.action).toBe("superseded");
		expect(res.details!.index).toBe("degraded");

		// Arquivo movido para .supersedes/ mesmo com índice falhando
		expect(existsSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "mem.md"))).toBeFalse();
		const supPath = join(MEMORIES_ROOT, ".supersedes", "projects", proj, "gotchas", "mem.md");
		expect(existsSync(supPath)).toBeTrue();
		expect(readFileSync(supPath, "utf-8")).toContain("superseded");
	});

	it("decay com índice indisponível (off) reporta index=off sem erro", async () => {
		const state: ToolState = {
			projectId: proj,
			currentSessionHash: "",
			lastPromptedBucket: -1,
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: null,
		};
		const tool = captureTool(registerMemoryDecay, state);
		// mem já foi superseded no teste anterior — recria fixture rápida
		const outraAbs = join(MEMORIES_ROOT, "projects", proj, "gotchas", "outra.md");
		ensureFileDir(outraAbs);
		writeFileSync(outraAbs, [
				"---",
				"context: outra",
				"type: gotchas",
				"confidence: 0.7",
				"---",
				"",
				"## [2026-08-01 10:00:00] Outra",
				"",
				"outra memória.",
			].join("\n"),
		);
		const res = await tool.execute("id4", { context: "outra", delta: 0.2 }, undefined, undefined, undefined);
		expect(res.details!.index).toBe("off");
		expect(res.details!.action).toBe("decayed");
		expect(res.details!.confidence).toBe(0.5);
	});
});
