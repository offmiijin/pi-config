/**
 * pi-memory — Tests: RetentionScheduler (sweep periódico de desuso).
 *
 * Fixtures vivem no MEMORIES_ROOT real sob projeto temporário (mesmo padrão
 * de memory.test.ts — findMemoryFile/listActiveMemoryFiles operam sobre o
 * root real). Índice e banco de atividade em diretórios temporários.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MEMORIES_ROOT } from "../constants.ts";
import { ensureFileDir } from "../session.ts";
import { MemoryIndex } from "../memory/memory-index.ts";
import { MemoryActivityStore } from "../memory/retention-store.ts";
import { RetentionScheduler, buildActiveDocs } from "../memory/retention-scheduler.ts";
import { DAY_MS } from "../memory/retention.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const MEM_PATH = (proj: string) =>
	join(MEMORIES_ROOT, "projects", proj, "gotchas", "cache.md");

/** Frontmatter v3 com created antiga e memory_id estável. */
function fixtureV3(): string {
	return [
		"---",
		'context: cache',
		'type: gotchas',
		'scope: project',
		'revision: 1',
		'created: "2026-01-01"',
		'updated: "2026-01-01"',
		'confidence: 0.8',
		'memory_id: "mem-sched"',
		'retention_policy: normal',
		"---",
		"",
		"# Cache invalidação",
		"",
		"Bug no cache.",
		"",
	].join("\n");
}

describe("RetentionScheduler", () => {
	let proj: string;
	let dbDir: string;
	let index: MemoryIndex;
	let store: MemoryActivityStore;
	let scheduler: RetentionScheduler;

	beforeAll(() => {
		proj = `__test_retention_${Date.now()}`;
		dbDir = mkdtempSync(join(tmpdir(), "ret-sched-"));
		ensureFileDir(MEM_PATH(proj));
		writeFileSync(MEM_PATH(proj), fixtureV3());

		index = new MemoryIndex(join(dbDir, "index.sqlite"), MEMORIES_ROOT);
		index.open();
		index.rebuild(proj);

		store = new MemoryActivityStore(join(dbDir, "retention.sqlite"));
		store.open();
		scheduler = new RetentionScheduler(store, index, { intervalMs: 60_000 });
	});

	afterAll(() => {
		scheduler.stop();
		store.close();
		index.close();
		rmSync(join(MEMORIES_ROOT, "projects", proj), { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	it("buildActiveDocs lê identidade, política e created do frontmatter", () => {
		const docs = buildActiveDocs(proj);
		const mine = docs.find((d) => d.memoryId === "mem-sched");
		expect(mine).toBeDefined();
		expect(mine!.policy).toBe("normal");
		expect(mine!.created).toBe("2026-01-01");
		expect(mine!.path).toBe(`projects/${proj}/gotchas/cache.md`);
	});

	it("sweep: reconcile + recompute + apply no índice", async () => {
		scheduler.setProject(proj);
		// 120 dias após a criação, sem nunca usar → grace 30 + 90 de meia-vida → ~0.5
		const result = await scheduler.sweep(new Date(T0.getTime() + 120 * DAY_MS));
		// O MEMORIES_ROOT real tem memórias globais — o reconcile adiciona todas.
		expect(result.reconcile.added).toBeGreaterThanOrEqual(1);
		expect(result.sweep.evaluated).toBeGreaterThanOrEqual(1);

		const rec = store.listActiveRecords(proj).find((r) => r.memoryId === "mem-sched");
		expect(rec).toBeDefined();
		expect(rec!.firstSeenAt).toBe("2026-01-01T00:00:00.000Z"); // de created, não do reconcile
		expect(rec!.retentionScore).toBeCloseTo(0.5, 3);

		// Score aplicado no índice — busca enxerga antes do próximo sweep.
		expect(result.applied).toBeGreaterThanOrEqual(1);
		const search = index.search({ terms: ["cache"], scope: "all", projectId: proj });
		const hit = search.find((r) => r.context === "cache");
		expect(hit).toBeDefined();
		expect(hit!.retentionScore).toBeCloseTo(0.5, 3);
	});

	it("sweep nunca altera markdown (nem confidence)", async () => {
		const before = readFileSync(MEM_PATH(proj), "utf-8");
		await scheduler.sweep(new Date(T0.getTime() + 500 * DAY_MS));
		const after = readFileSync(MEM_PATH(proj), "utf-8");
		expect(after).toBe(before);
		expect(after).toContain('confidence: 0.8');
	});

	it("sweep concorrente reutiliza o em andamento (sem escrita duplicada)", async () => {
		const [a, b] = await Promise.all([scheduler.sweep(), scheduler.sweep()]);
		expect(a).toBe(b);
	});

	it("start/stop controla o ciclo periódico", () => {
		scheduler.start(proj);
		expect(scheduler.isRunning).toBe(true);
		scheduler.stop();
		expect(scheduler.isRunning).toBe(false);
	});

	it("sweep sem projeto ativo lança (erro claro, não quebra a sessão)", async () => {
		const orphan = new RetentionScheduler(store, index);
		let threw = false;
		try {
			await orphan.sweep();
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it("protected (_rules) nunca decai mesmo com desuso extremo", async () => {
		// _rules global com created antiga
		const rulesPath = join(MEMORIES_ROOT, "_global", "_rules", "regra.md");
		ensureFileDir(rulesPath);
		writeFileSync(
			rulesPath,
			[
				"---",
				'context: regra',
				'type: _rules',
				'scope: global',
				'revision: 1',
				'created: "2025-01-01"',
				'updated: "2025-01-01"',
				'confidence: 0.9',
				'memory_id: "mem-rules"',
				'retention_policy: protected',
				"---",
				"",
				"# Regra",
				"",
				"Sempre X.",
				"",
			].join("\n"),
		);
		try {
			const s2 = new RetentionScheduler(store, index);
			s2.setProject(proj);
			await s2.sweep(new Date(T0.getTime() + 5000 * DAY_MS));
			const rec = store.listActiveRecords(proj).find((r) => r.memoryId === "mem-rules");
			expect(rec?.retentionScore).toBe(1);
		} finally {
			rmSync(join(MEMORIES_ROOT, "_global", "_rules", "regra.md"), { force: true });
		}
	});
});
