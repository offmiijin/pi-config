/**
 * Tests for search.ts — engine cascade
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, randomDelay: vi.fn().mockResolvedValue(undefined), throttleSearch: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../config", () => ({
	getSerperKey: () => "mock-serper-key",
	getExaKey: () => "mock-exa-key",
	getTavilyKey: () => "mock-tavily-key",
	getSearxngKey: () => mockSearxng.key,
	getSearxngUrl: () => mockSearxng.url,
	getSearxngTargetUrl: () => "http://localhost:4000",
	getConfiguredProviders: () => mockConfigured,
	setKey: vi.fn(),
	getConfigSummary: () => "",
}));

const { mockConfigured, mockSearxng } = vi.hoisted(() => ({
	mockConfigured: ["searxng", "serper", "exa", "tavily"],
	mockSearxng: { url: "http://localhost:4000" as string | null, key: "mock-searxng-key" as string | null },
}));

import { search, isSearxngReachable, validateProvider, resetSearxngReachCache } from "../search";

interface MockResult {
	title: string;
	url: string;
	snippet: string;
}

function makeResponse(results: MockResult[]): Response {
	return {
		ok: true,
		status: 200,
		headers: { get: () => "application/json" } as unknown as Headers,
		json: async () => ({ results, organic: results }),
		text: async () => "",
		clone: function () { return this as unknown as Response },
	} as Response;
}

function makeError(status: number): Response {
	return {
		ok: false,
		status,
		headers: { get: () => null } as unknown as Headers,
		json: async () => ({}),
		text: async () => `HTTP ${status}`,
		clone: function () { return this as unknown as Response },
	} as Response;
}

describe("search — SearXNG → Tavily → Exa → Serper cascade", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		mockSearxng.url = "http://localhost:4000";
		mockSearxng.key = "mock-searxng-key";
		resetSearxngReachCache();
	});

	it("returns results from SearXNG (primary, local)", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			makeResponse([{ title: "SearXNG Result", url: "https://local.searxng", snippet: "local result" }]),
		);
		vi.stubGlobal("fetch", mockFetch);

		const result = await search("test");
		expect(result.source).toBe("searxng");
		expect(result.results).toHaveLength(1);
		expect(result.results[0].title).toBe("SearXNG Result");
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("falls back to Tavily when SearXNG fails", async () => {
		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) return Promise.resolve(makeError(503));
			return Promise.resolve(makeResponse([{ title: "Tavily Result", url: "https://tavily.com", snippet: "tavily snippet" }]));
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await search("test");
		expect(result.source).toBe("tavily");
		expect(result.results).toHaveLength(1);
		expect(result.results[0].title).toBe("Tavily Result");
	});

	it("falls back to Exa when SearXNG and Tavily fail", async () => {
		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount <= 2) return Promise.resolve(makeError(500));
			return Promise.resolve(makeResponse([{ title: "Exa Result", url: "https://exa.com", snippet: "exa snippet" }]));
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await search("test");
		expect(result.source).toBe("exa");
		expect(result.results).toHaveLength(1);
		expect(result.results[0].title).toBe("Exa Result");
	});

	it("falls back to Serper when first 3 engines fail", async () => {
		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount <= 3) return Promise.resolve(makeError(500));
			return Promise.resolve({
				ok: true,
				status: 200,
				headers: { get: () => "application/json" } as unknown as Headers,
				json: async () => ({ organic: [{ title: "Serper Result", link: "https://serper.com", snippet: "serper snippet" }] }),
				text: async () => "",
				clone: function () { return this as unknown as Response },
			} as Response);
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await search("test");
		expect(result.source).toBe("serper");
		expect(result.results).toHaveLength(1);
		expect(result.results[0].title).toBe("Serper Result");
	});

	it("returns error when all 4 engines fail", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeError(500)));

		const result = await search("test");
		expect(result.results).toEqual([]);
		expect(result.error).toContain("All engines failed");
	});

	it("returns setup guidance when no provider is configured", async () => {
		const original = mockConfigured.slice();
		mockConfigured.length = 0;
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeError(500)));

		const result = await search("test");
		expect(result.results).toEqual([]);
		expect(result.error).toContain("Nenhum provedor de busca configurado");
		expect(result.error).toContain("/web_search config");
		mockConfigured.push(...original);
	});

	it("usa SearXNG sem config quando responde (probe ok)", async () => {
		mockSearxng.url = null;
		mockSearxng.key = null;
		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) return Promise.resolve(makeResponse([])); // probe: ok
			return Promise.resolve(makeResponse([{ title: "SearXNG Result", url: "https://local.searxng", snippet: "local" }]));
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await search("test");
		expect(result.source).toBe("searxng");
		expect(result.results).toHaveLength(1);
		expect(mockFetch).toHaveBeenCalledTimes(2); // probe + busca
	});

	it("pula SearXNG quando não configurado e não responde (cai p/ Tavily)", async () => {
		mockSearxng.url = null;
		mockSearxng.key = null;
		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) return Promise.reject(new Error("ECONNREFUSED")); // probe falha
			return Promise.resolve(makeResponse([{ title: "Tavily Result", url: "https://tavily.com", snippet: "tavily" }]));
		});
		vi.stubGlobal("fetch", mockFetch);

		const result = await search("test");
		expect(result.source).toBe("tavily");
		expect(result.results).toHaveLength(1);
		expect(mockFetch).toHaveBeenCalledTimes(2); // probe + tavily (sem timeout de 10s)
	});
});

describe("isSearxngReachable / validateProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetSearxngReachCache();
	});

	it("detects reachable SearXNG", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse([])));
		expect(await isSearxngReachable()).toBe(true);
	});

	it("detects unreachable SearXNG (Docker parado)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
		expect(await isSearxngReachable()).toBe(false);
	});

	it("caches the probe per process", async () => {
		const f = vi.fn().mockResolvedValue(makeResponse([]));
		vi.stubGlobal("fetch", f);
		await isSearxngReachable();
		await isSearxngReachable();
		expect(f).toHaveBeenCalledTimes(1);
	});

	it("validateProvider('searxng') ok quando alcançável", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse([])));
		const v = await validateProvider("searxng");
		expect(v.ok).toBe(true);
	});

	it("validateProvider desconhecido → falha", async () => {
		const v = await validateProvider("nope");
		expect(v.ok).toBe(false);
		expect(v.detail).toContain("nope");
	});
});
