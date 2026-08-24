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
	getRendererCommand,
	getRendererMode,
	getRendererTimeoutMs,
	getSearxngTargetUrl,
	isDockerSocketAvailable,
} from "../config";

describe("config — portabilidade", () => {
	afterEach(() => {
		delete process.env.SEARXNG_URL;
		delete process.env.SEARXNG_KEY;
		delete process.env.SERPER_API_KEY;
		delete process.env.PI_WEB_RENDERER;
		delete process.env.PI_WEB_RENDERER_COMMAND;
		delete process.env.PI_WEB_RENDERER_TIMEOUT_MS;
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

	it("renderer usa modo auto por padrão e aceita override por ambiente", () => {
		expect(getRendererMode()).toBe("auto");
		process.env.PI_WEB_RENDERER = "required";
		expect(getRendererMode()).toBe("required");
	});

	it("renderer respeita comando e timeout configurados no ambiente", () => {
		process.env.PI_WEB_RENDERER_COMMAND = "/tmp/pi-web-renderer";
		process.env.PI_WEB_RENDERER_TIMEOUT_MS = "90000";
		expect(getRendererCommand()).toBe("/tmp/pi-web-renderer");
		expect(getRendererTimeoutMs()).toBe(60_000);
	});
});
