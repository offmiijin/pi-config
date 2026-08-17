/**
 * pi-memory — Tests: tool memory_retention (status/preview/run).
 *
 * Mesmo padrão de tools-decay.test.ts: execute() real da tool com mock
 * mínimo de ExtensionAPI + store/scheduler reais em diretório temporário.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MEMORIES_ROOT } from "../constants.ts";
import { ensureFileDir } from "../session.ts";
import { MemoryActivityStore } from "../memory/retention-store.ts";
import { RetentionScheduler } from "../memory/retention-scheduler.ts";
import { registerMemoryRetention } from "../tools/retention.ts";
import type { ToolState } from "../tools/state.ts";
import { DAY_MS } from "../memory/retention.ts";

interface ToolDef {
	execute: (
		...args: unknown[]
	) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

function captureTool(
	register: (pi: any, state: ToolState) => void,
	state: ToolState,
): ToolDef {
	let def: ToolDef | null = null;
	const fakePi = { registerTool: (d: ToolDef) => { def = d; } };
	register(fakePi, state);
	if (!def) throw new Error("registerTool não capturou a definição");
	return def;
}

describe("memory_retention", () => {
	let proj: string;
	let dbDir: string;
	let store: MemoryActivityStore;
	let scheduler: RetentionScheduler;
	let state: ToolState;

	beforeAll(() => {
		proj = `__test_ret_tool_${Date.now()}`;
		dbDir = mkdtempSync(join(tmpdir(), "ret-tool-"));
		ensureFileDir(join(MEMORIES_ROOT, "projects", proj, "gotchas", "cache.md"));
		writeFileSync(
			join(MEMORIES_ROOT, "projects", proj, "gotchas", "cache.md"),
			[
				"---",
				'context: cache',
				'type: gotchas',
				'scope: project',
				'revision: 1',
				'created: "2026-01-01"',
				'updated: "2026-01-01"',
				'confidence: 0.8',
				'memory_id: "mem-tool"',
				'retention_policy: normal',
				"---",
				"",
				"# Cache",
				"",
				"Bug no cache.",
				"",
			].join("\n"),
		);

		store = new MemoryActivityStore(join(dbDir, "retention.sqlite"));
		store.open();
		scheduler = new RetentionScheduler(store, null, { intervalMs: 60_000 });
		scheduler.setProject(proj);

		state = {
			projectId: proj,
			currentSessionHash: "s",
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: null,
			pipeline: null,
			worker: null,
			retention: store,
			retentionScheduler: scheduler,
		};
	});

	afterAll(() => {
		scheduler.stop();
		store.close();
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("com módulo desativado responde disabled sem erro", async () => {
		const offState: ToolState = { ...state, retention: null, retentionScheduler: null };
		const tool = captureTool(registerMemoryRetention, offState);
		const res = await tool.execute("id", { action: "status" });
		expect(res.content[0].text).toContain("disabled");
		expect(res.details?.enabled).toBe(false);
	});

	it("status reporta métricas do store", async () => {
		await scheduler.sweep(); // popula o store (reconcile do fixture)
		const tool = captureTool(registerMemoryRetention, state);
		const res = await tool.execute("id", { action: "status" });
		expect(res.details?.enabled).toBe(true);
		const m = res.details?.metrics as { tracked: number; neverUsed: number };
		expect(m.tracked).toBeGreaterThan(0);
		expect(m.neverUsed).toBeGreaterThanOrEqual(0);
	});

	it("preview é dry-run: não grava nada (scores e last_sweep_at intactos)", async () => {
		// Popula o store antes do preview (um sweep real)
		await scheduler.sweep();
		const before = store.getMetrics(proj);
		const recordsBefore = store.listActiveRecords(proj).map((r) => `${r.memoryId}:${r.retentionScore}`).sort();

		const tool = captureTool(registerMemoryRetention, state);
		const res = await tool.execute("id", { action: "preview" });
		expect(res.content[0].text).toContain("preview");
		expect(res.details?.preview).toBeDefined();

		// Nada mudou após o preview
		const after = store.getMetrics(proj);
		expect(after.lastSweepAt).toBe(before.lastSweepAt);
		const recordsAfter = store.listActiveRecords(proj).map((r) => `${r.memoryId}:${r.retentionScore}`).sort();
		expect(recordsAfter).toEqual(recordsBefore);
	});

	it("run executa sweep de verdade (last_sweep_at atualizado)", async () => {
		const tool = captureTool(registerMemoryRetention, state);
		const res = await tool.execute("id", { action: "run" });
		expect(res.content[0].text).toContain("Sweep executed");
		const sweep = res.details?.sweep as { reconcile: { added: number } };
		expect(sweep.reconcile.added).toBeGreaterThanOrEqual(0);
		expect(store.getMeta("last_sweep_at")).not.toBe(null);
	});
});
