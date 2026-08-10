/**
 * Tests for config.ts — portabilidade (searxng via URL, targets, docker).
 */

import { describe, it, expect, afterEach, vi } from "vitest";

// Isola do config.json real da máquina (env vars continuam testáveis)
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: () => false };
});

import {
	getConfiguredProviders,
	getSearxngTargetUrl,
	isDockerSocketAvailable,
} from "../config";

describe("config — portabilidade", () => {
	afterEach(() => {
		delete process.env.SEARXNG_URL;
		delete process.env.SEARXNG_KEY;
		delete process.env.SERPER_API_KEY;
	});

	it("searxng via URL (sem chave) conta como provider configurado", () => {
		process.env.SEARXNG_URL = "http://localhost:4000";
		expect(getConfiguredProviders()).toContain("searxng");
	});

	it("searxng sem chave e sem URL não conta como configurado", () => {
		expect(getConfiguredProviders()).not.toContain("searxng");
	});

	it("chave cloud conta como provider", () => {
		process.env.SERPER_API_KEY = "abc";
		expect(getConfiguredProviders()).toContain("serper.dev");
	});

	it("getSearxngTargetUrl usa env e remove barra final", () => {
		process.env.SEARXNG_URL = "http://localhost:4000/";
		expect(getSearxngTargetUrl()).toBe("http://localhost:4000");
	});

	it("getSearxngTargetUrl tem default localhost:4000", () => {
		expect(getSearxngTargetUrl()).toBe("http://localhost:4000");
	});

	it("isDockerSocketAvailable retorna boolean (sem lançar)", () => {
		expect(typeof isDockerSocketAvailable()).toBe("boolean");
	});
});
