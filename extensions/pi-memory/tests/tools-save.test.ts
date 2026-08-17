/**
 * pi-memory — Tests: tool memory_save (wiring real com supersedes/consolidate).
 *
 * Exercita o execute() real com mock mínimo de ExtensionAPI e um MemoryIndex
 * real sobre o MEMORIES_ROOT (projeto temporário, removido no afterAll — mesmo
 * padrão de tools-decay.test.ts). Valida que supersedes/consolidate propagam a
 * remoção ao índice FTS5 na MESMA transação.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MEMORIES_ROOT } from "../constants.ts";
import { MemoryIndex, readMemoryDocFromFile, relFromMemoriesRoot } from "../memory/memory-index.ts";
import { saveMemory } from "../memory/memory.ts";
import { registerMemorySave } from "../tools/save.ts";
import type { ToolState } from "../tools/state.ts";

interface ToolDef {
	execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

function captureTool(state: ToolState): ToolDef {
	let def: ToolDef | null = null;
	const fakePi = {
		registerTool: (d: ToolDef) => {
			def = d;
		},
	};
	registerMemorySave(fakePi as never, state);
	if (!def) throw new Error("registerTool não capturou a definição");
	return def;
}

describe("memory_save — supersedes/consolidate propagam ao índice", () => {
	let proj: string;
	let dbDir: string;
	let dbPath: string;
	let idx: MemoryIndex;

	function makeState(): ToolState {
		return {
			projectId: proj,
			currentSessionHash: "",
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			pipeline: null,
			worker: null,
			retention: null,
			retentionScheduler: null,
			index: idx,
		};
	}

	function searchPaths(terms: string[], project: string): string[] {
		return idx.search({ terms, projectId: project }).map((r) => r.path);
	}

	function indexSaved(result: { file: string }): void {
		idx.upsertDocument(readMemoryDocFromFile(result.file, relFromMemoriesRoot(result.file)));
	}

	beforeAll(() => {
		proj = `__test_save_${Date.now()}`;
		dbDir = mkdtempSync(join(tmpdir(), "pi-memory-save-db-"));
		dbPath = join(dbDir, "save.sqlite");
		idx = new MemoryIndex(dbPath, MEMORIES_ROOT);
		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		idx.close();
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "projects", proj), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".history", "projects", proj), { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("supersede entre contextos remove o antigo da FTS e indexa o novo", async () => {
		const a = saveMemory(proj, {
			type: "gotchas",
			context: "old-save",
			title: "Velha",
			content: "token_save_antigo_xyz",
			scope: "project",
		});
		indexSaved(a);
		expect(searchPaths(["token_save_antigo_xyz"], proj)).toContain(`projects/${proj}/gotchas/old-save.md`);

		const tool = captureTool(makeState());
		const res = await tool.execute(
			"id1",
			{
				type: "lessons",
				context: "new-save",
				title: "Nova",
				content: "token_save_novo_xyz",
				scope: "project",
				supersedes: "old-save",
			},
			undefined,
			undefined,
			undefined,
		);

		expect(res.details!.index).toBe("synced");
		expect(res.details!.action).toBe("created");
		expect((res.details!.archived as string[])[0]).toBe(a.file);

		// Antigo fora da FTS; novo buscável
		expect(searchPaths(["token_save_antigo_xyz"], proj)).not.toContain(`projects/${proj}/gotchas/old-save.md`);
		expect(searchPaths(["token_save_novo_xyz"], proj)).toContain(`projects/${proj}/lessons/new-save.md`);

		// Arquivo movido para .supersedes/
		expect(existsSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "old-save.md"))).toBeFalse();
		expect(existsSync(join(MEMORIES_ROOT, ".supersedes", "projects", proj, "gotchas", "old-save.md"))).toBeTrue();
	});

	it("consolidate no mesmo path mantém só a versão nova", async () => {
		const a = saveMemory(proj, {
			type: "gotchas",
			context: "cons-save",
			title: "Versão 1",
			content: "token_cons_antigo_xyz",
			scope: "project",
		});
		indexSaved(a);

		const tool = captureTool(makeState());
		const res = await tool.execute(
			"id2",
			{
				type: "gotchas",
				context: "cons-save",
				title: "Versão 2",
				content: "token_cons_novo_xyz",
				scope: "project",
			},
			undefined,
			undefined,
			undefined,
		);

		expect(res.details!.index).toBe("synced");
		expect(res.details!.action).toBe("consolidated");
		expect((res.details!.archived as string[])[0]).toBe(a.file);

		expect(searchPaths(["token_cons_antigo_xyz"], proj)).not.toContain(`projects/${proj}/gotchas/cons-save.md`);
		expect(searchPaths(["token_cons_novo_xyz"], proj)).toContain(`projects/${proj}/gotchas/cons-save.md`);
	});

	it("reescrita (append legado) arquiva em .history/ e mantém só a versão nova na FTS", async () => {
		const a = saveMemory(proj, {
			type: "gotchas",
			context: "append-save",
			title: "Antiga",
			content: "token_app_antigo_xyz",
			scope: "project",
		});
		indexSaved(a);

		const tool = captureTool(makeState());
		const res = await tool.execute(
			"id3",
			{
				type: "gotchas",
				context: "append-save",
				title: "Nova",
				content: "token_app_novo_xyz",
				scope: "project",
			},
			undefined,
			undefined,
			undefined,
		);

		expect(res.details!.index).toBe("synced");
		expect(res.details!.action).toBe("consolidated");
		expect((res.details!.archived as string[])[0]).toBe(a.file);

		// Snapshot: só a versão nova fica buscável; a antiga foi para .history/
		expect(searchPaths(["token_app_antigo_xyz"], proj)).not.toContain(`projects/${proj}/gotchas/append-save.md`);
		expect(searchPaths(["token_app_novo_xyz"], proj)).toContain(`projects/${proj}/gotchas/append-save.md`);
		expect(existsSync(join(MEMORIES_ROOT, ".history", "projects", proj, "gotchas", "append-save", "v1.md"))).toBeTrue();
	});

	it("índice indisponível (off): markdown salvo, index=off", async () => {
		const state = makeState();
		state.index = null;
		const tool = captureTool(state);
		const res = await tool.execute(
			"id4",
			{ type: "gotchas", context: "off-save", title: "Off", content: "token_off_xyz", scope: "project" },
			undefined,
			undefined,
			undefined,
		);

		expect(res.details!.index).toBe("off");
		expect(res.details!.action).toBe("created");
		expect(existsSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "off-save.md"))).toBeTrue();
	});
});
