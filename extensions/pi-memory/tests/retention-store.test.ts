/**
 * pi-memory — Tests: MemoryActivityStore (.retention.sqlite).
 *
 * Banco em diretório temporário (mkdtemp) — nunca toca no .retention.sqlite
 * de produção. Cobre reconcile (inserção/atualização/desativação/rename),
 * recordAccess (por id e por path), recompute (decay + protected +
 * idempotência), métricas e persistência entre reaberturas.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryActivityStore, type ActiveDoc } from "../memory/retention-store.ts";
import { DAY_MS } from "../memory/retention.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

function doc(overrides: Partial<ActiveDoc> = {}): ActiveDoc {
	const memoryId = overrides.memoryId ?? "mem-1";
	return {
		memoryId,
		// Path derivado do memory_id — cada memória de teste tem path único
		// (a tabela impõe UNIQUE(path), como o índice real).
		path: `_global/gotchas/${memoryId}.md`,
		scope: "global",
		projectId: null,
		type: "gotchas",
		context: memoryId,
		policy: "normal",
		...overrides,
	};
}

function openStore(dbPath: string): MemoryActivityStore {
	const s = new MemoryActivityStore(dbPath);
	s.open();
	return s;
}

describe("MemoryActivityStore", () => {
	let dir: string;
	let dbPath: string;
	let store: MemoryActivityStore;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ret-store-"));
		dbPath = join(dir, "retention.sqlite");
		store = openStore(dbPath);
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("reconcile insere e é idempotente (segunda chamada atualiza, não duplica)", () => {
		const r1 = store.reconcile([doc()], "proj-a", T0);
		expect(r1.added).toBe(1);
		expect(store.listActiveRecords("proj-a").length).toBe(1);

		const r2 = store.reconcile([doc()], "proj-a", new Date(T0.getTime() + DAY_MS));
		expect(r2.added).toBe(0);
		expect(r2.updated).toBe(1);
		expect(store.listActiveRecords("proj-a").length).toBe(1);
	});

	it("renome de path preserva first_seen_at e identidade", () => {
		store.reconcile([doc({ memoryId: "mem-ren" })], "proj-a", T0);
		store.reconcile(
			[doc({ memoryId: "mem-ren", path: "_global/gotchas/mem-ren-renamed.md" })],
			"proj-a",
			new Date(T0.getTime() + 10 * DAY_MS),
		);
		const rec = store.listActiveRecords("proj-a").find((r) => r.memoryId === "mem-ren");
		expect(rec?.path).toBe("_global/gotchas/mem-ren-renamed.md");
		expect(rec?.firstSeenAt).toBe(T0.toISOString());
	});

	it("recordAccess por memory_id: last_used_at, use_count e reset de score", () => {
		store.reconcile([doc({ memoryId: "mem-use" })], "proj-a", T0);
		// Envelhece até o piso
		store.recompute("proj-a", new Date(T0.getTime() + 1000 * DAY_MS));
		const before = store.listActiveRecords("proj-a").find((r) => r.memoryId === "mem-use")!;
		expect(before.retentionScore).toBeLessThan(1);

		const res = store.recordAccess("mem-use", "_global/gotchas/cache.md", new Date(T0.getTime() + 1001 * DAY_MS));
		expect(res.recorded).toBe(true);
		expect(res.useCount).toBe(1);

		const after = store.listActiveRecords("proj-a").find((r) => r.memoryId === "mem-use")!;
		expect(after.retentionScore).toBe(1);
		expect(after.lastUsedAt).not.toBe(null);
		expect(after.useCount).toBe(1);
	});

	it("recordAccess por path (memoryId null) resolve a linha", () => {
		store.reconcile([doc({ memoryId: "mem-path" })], "proj-a", T0);
		const res = store.recordAccess(null, "_global/gotchas/mem-path.md");
		expect(res.recorded).toBe(true);
		const rec = store.listActiveRecords("proj-a").find((r) => r.memoryId === "mem-path")!;
		expect(rec.useCount).toBe(1);
	});

	it("recordAccess de linha desconhecida → recorded=false (não quebra busca)", () => {
		const res = store.recordAccess("mem-desconhecida", "_global/gotchas/nope.md");
		expect(res.recorded).toBe(false);
	});

	it("recompute decai normal e pula protected", () => {
		store.reconcile(
			[
				doc({ memoryId: "mem-decay", policy: "normal" }),
				doc({ memoryId: "mem-prot", policy: "protected" }),
			],
			"proj-a",
			T0,
		);
		const r = store.recompute("proj-a", new Date(T0.getTime() + 120 * DAY_MS));
		expect(r.protectedCount).toBe(1);
		expect(r.decayed).toBeGreaterThan(0);

		const decayed = store.listActiveRecords("proj-a").find((r2) => r2.memoryId === "mem-decay")!;
		const prot = store.listActiveRecords("proj-a").find((r2) => r2.memoryId === "mem-prot")!;
		expect(decayed.retentionScore).toBeLessThan(1);
		expect(prot.retentionScore).toBe(1);
	});

	it("recompute idempotente: segunda chamada não muda scores", () => {
		const before = store.listActiveRecords("proj-a").map((r) => `${r.memoryId}:${r.retentionScore}`).sort();
		const r2 = store.recompute("proj-a", new Date(T0.getTime() + 120 * DAY_MS));
		expect(r2.decayed).toBe(0);
		const after = store.listActiveRecords("proj-a").map((r) => `${r.memoryId}:${r.retentionScore}`).sort();
		expect(after).toEqual(before);
	});

	it("reconcile desativa linha removida do disco", () => {
		store.reconcile(
			[doc({ memoryId: "mem-gone", path: "_global/gotchas/gone.md" })],
			"proj-a",
			T0,
		);
		store.reconcile([], "proj-a", T0);
		const rec = store.listActiveRecords("proj-a").find((r) => r.memoryId === "mem-gone");
		expect(rec).toBeUndefined();
	});

	it("listScoresByPath e getMetrics refletem o estado", () => {
		// Self-contained: o teste anterior desativou todas as linhas de proj-a.
		store.reconcile([doc({ memoryId: "mem-metrics" })], "proj-a", T0);
		const scores = store.listScoresByPath("proj-a");
		expect(scores.size).toBeGreaterThan(0);
		expect(scores.get("_global/gotchas/mem-metrics.md")).toBe(1);
		const metrics = store.getMetrics("proj-a");
		expect(metrics.tracked).toBeGreaterThan(0);
		expect(metrics.neverUsed).toBeGreaterThanOrEqual(0);
		expect(metrics.lastSweepAt).not.toBe(null);
	});

	it("persiste entre reaberturas (arquivo derivado, dados sobrevivem)", () => {
		const path = join(dir, "persist.sqlite");
		const s1 = openStore(path);
		s1.reconcile([doc({ memoryId: "mem-persist" })], "proj-p", T0);
		s1.close();

		const s2 = openStore(path);
		const rec = s2.listActiveRecords("proj-p").find((r) => r.memoryId === "mem-persist");
		expect(rec?.path).toBe("_global/gotchas/mem-persist.md");
		s2.close();
	});

	it("linhas de outros projetos não são desativadas por reconcile alheio", () => {
		store.reconcile([doc({ memoryId: "mem-other", projectId: "proj-outro", scope: "project", path: "projects/proj-outro/gotchas/x.md" })], "proj-outro", T0);
		store.reconcile([], "proj-a", T0);
		const rec = store.listActiveRecords("proj-outro").find((r) => r.memoryId === "mem-other");
		expect(rec).toBeDefined();
	});
});
