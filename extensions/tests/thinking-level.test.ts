/**
 * Extensão thinking-level — testes unitários.
 *
 * Cobre: derivação de níveis suportados por modelo (getSupportedLevels),
 * parsing robusto da seleção (parseSelectedLevel) e sugestão de nível
 * quando o atual não é suportado (clampLevel). Fixtures reais do
 * models-store (catálogo cacheado pelo pi).
 */

import { describe, it, expect } from "vitest";

import {
	getSupportedLevels,
	parseSelectedLevel,
	clampLevel,
} from "../thinking-level";

describe("getSupportedLevels", () => {
	it("sem modelo retorna níveis padrão off..high", () => {
		expect(getSupportedLevels()).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("modelo sem thinkingLevelMap retorna níveis padrão off..high", () => {
		expect(getSupportedLevels({ reasoning: true })).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("modelo sem reasoning suporta apenas off", () => {
		expect(getSupportedLevels({ reasoning: false })).toEqual(["off"]);
	});

	it("deepseek-v4-flash (opencode-go): apenas off, high, max", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
		};
		expect(getSupportedLevels(model)).toEqual(["off", "high", "max"]);
	});

	it("deepseek-v4-flash (openrouter): off, high, xhigh", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				max: null,
				xhigh: "xhigh",
			},
		};
		expect(getSupportedLevels(model)).toEqual(["off", "high", "xhigh"]);
	});

	it("kimi-k3: apenas max", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: "max",
			},
		};
		expect(getSupportedLevels(model)).toEqual(["max"]);
	});

	it("hy3: off, low, high", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
		};
		expect(getSupportedLevels(model)).toEqual(["off", "low", "high"]);
	});

	it("gpt-5.6-luna: low..max", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		};
		expect(getSupportedLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});
});

describe("parseSelectedLevel", () => {
	it("extrai nível do sufixo [valor]", () => {
		expect(parseSelectedLevel("● High — Alto esforço de reasoning [high]")).toBe("high");
		expect(parseSelectedLevel("  Max — Esforço máximo de reasoning [max]")).toBe("max");
		expect(parseSelectedLevel("  Off — Sem reasoning/thinking [off]")).toBe("off");
	});

	it("ignora opção sem sufixo válido", () => {
		expect(parseSelectedLevel("lixo sem sufixo")).toBeUndefined();
		expect(parseSelectedLevel("  Fake — teste [fake]")).toBeUndefined();
		expect(parseSelectedLevel("  Max — Esforço máximo [max] traíra")).toBeUndefined();
	});
});

describe("clampLevel", () => {
	it("nível já suportado retorna ele mesmo", () => {
		expect(clampLevel("high", ["off", "high", "max"])).toBe("high");
	});

	it("xhigh com [off, high, max] sugere high (maior suportado ≤ atual)", () => {
		expect(clampLevel("xhigh", ["off", "high", "max"])).toBe("high");
	});

	it("max com [off, high] sugere high", () => {
		expect(clampLevel("max", ["off", "high"])).toBe("high");
	});

	it("medium com [low, high] sugere low", () => {
		expect(clampLevel("medium", ["low", "high"])).toBe("low");
	});

	it("off com [low, high] sugere o menor suportado (low)", () => {
		expect(clampLevel("off", ["low", "high"])).toBe("low");
	});

	it("minimal com apenas [max] sugere max", () => {
		expect(clampLevel("minimal", ["max"])).toBe("max");
	});

	it("lista vazia retorna undefined", () => {
		expect(clampLevel("high", [])).toBeUndefined();
	});
});
