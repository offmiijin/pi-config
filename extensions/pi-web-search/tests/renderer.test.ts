import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.hoisted(() => vi.fn());
const rendererInstalling = vi.hoisted(() => vi.fn(() => false));

vi.mock("../renderer-install", () => ({
	isRendererInstallationInProgress: rendererInstalling,
}));

vi.mock("../renderer-client", () => ({
	getSharedRendererClient: () => ({ render }),
}));

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		randomDelay: vi.fn().mockResolvedValue(undefined),
		randomUserAgent: vi.fn().mockReturnValue("TestAgent/1.0"),
	};
});

import { fetchPages } from "../fetch";
import { writeFile } from "node:fs/promises";

describe("web_fetch — renderer JavaScript", () => {
	beforeEach(() => {
		process.env.PI_WEB_RENDERER = "auto";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/app",
			headers: { get: () => "text/html" },
			text: async () =>
				'<html><body><div id="root"></div><script src="app.js"></script><script src="vendor.js"></script><script src="runtime.js"></script></body></html>',
		}));
		render.mockReset();
		rendererInstalling.mockReturnValue(false);
	});

	afterEach(() => {
		delete process.env.PI_WEB_RENDERER;
		rendererInstalling.mockReturnValue(false);
		vi.unstubAllGlobals();
	});

	it("renderiza shells de SPA e converte o HTML retornado", async () => {
		render.mockResolvedValue({
			finalUrl: "https://example.com/app/loaded",
			html: "<article><h1>Conteúdo carregado</h1><p>Texto da aplicação.</p></article>",
			status: 200,
		});

		const output = await fetchPages(["https://example.com/app"], "/tmp/project");

		expect(render).toHaveBeenCalledWith("https://example.com/app", undefined);
		expect(output.results[0].rendered).toBe(true);
		expect(output.results[0].note).toContain("Playwright");
		expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("Conteúdo carregado"),
			"utf-8",
		);
	});

	it("mantém o HTML original quando o renderer falha em modo auto", async () => {
		render.mockRejectedValue(new Error("renderer ausente"));

		const output = await fetchPages(["https://example.com/app"], "/tmp/project");

		expect(output.succeeded).toBe(1);
		expect(output.results[0].rendered).toBe(false);
		expect(output.results[0].note).toContain("renderer indisponível");
	});

	it("não usa o renderer enquanto a instalação está em andamento", async () => {
		rendererInstalling.mockReturnValue(true);

		const output = await fetchPages(["https://example.com/app"], "/tmp/project");

		expect(render).not.toHaveBeenCalled();
		expect(output.succeeded).toBe(1);
		expect(output.results[0].note).toContain("em instalação");
	});

	it("falha explicitamente quando o renderer é obrigatório", async () => {
		process.env.PI_WEB_RENDERER = "required";
		render.mockRejectedValue(new Error("Chromium ausente"));

		const output = await fetchPages(["https://example.com/app"], "/tmp/project");

		expect(output.succeeded).toBe(0);
		expect(output.failed).toBe(1);
		expect(output.results[0].error).toContain("Renderer obrigatório");
	});
});
