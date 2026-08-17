/**
 * pi-memory — Tests: algoritmo de retenção (funções puras).
 */

import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { computeRetentionScore, DAY_MS, idleDays } from "../memory/retention.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("idleDays", () => {
	it("usa last_used_at quando a memória foi usada", () => {
		const now = new Date(T0.getTime() + 120 * DAY_MS);
		// Jan 1 → Jan 15 = 14 dias; 120 - 14 = 106
		expect(idleDays(now, "2026-01-15T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(106);
	});
	it("usa first_seen_at (criação) quando nunca usada", () => {
		const now = new Date(T0.getTime() + 120 * DAY_MS);
		expect(idleDays(now, null, "2026-01-01T00:00:00.000Z")).toBe(120);
	});
	it("nunca negativo (relógio regressivo)", () => {
		const now = new Date(T0.getTime() - 5 * DAY_MS);
		expect(idleDays(now, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(0);
	});
});

describe("computeRetentionScore", () => {
	it("grace period: sem decay antes de 30 dias", () => {
		expect(computeRetentionScore(0)).toBe(1);
		expect(computeRetentionScore(29)).toBe(1);
		expect(computeRetentionScore(30)).toBe(1);
	});
	it("meia-vida: cai pela metade a cada 90 dias de desuso", () => {
		expect(computeRetentionScore(30 + 90)).toBeCloseTo(0.5, 3);
		expect(computeRetentionScore(30 + 180)).toBeCloseTo(0.25, 3);
		expect(computeRetentionScore(30 + 270)).toBeCloseTo(0.125, 3);
	});
	it("exemplos do doc de arquitetura", () => {
		// 75d sem uso → ~0.71 · 120d → ~0.50 · 210d → ~0.25
		expect(Math.abs(computeRetentionScore(75) - 0.707)).toBeLessThan(0.005);
		expect(Math.abs(computeRetentionScore(120) - 0.5)).toBeLessThan(0.005);
		expect(Math.abs(computeRetentionScore(210) - 0.25)).toBeLessThan(0.005);
	});
	it("piso: nunca abaixo de RETENTION_MIN_SCORE", () => {
		expect(computeRetentionScore(1_000_000)).toBe(0.05);
	});
	it("aceita opts customizados (preview/teste)", () => {
		const score = computeRetentionScore(15, { graceDays: 5, halfLifeDays: 10 });
		expect(score).toBeCloseTo(2 ** (-10 / 10), 3);
	});
	it("arredonda para 3 casas", () => {
		const s = computeRetentionScore(31);
		expect(Number(s.toFixed(3))).toBe(s);
	});
});
