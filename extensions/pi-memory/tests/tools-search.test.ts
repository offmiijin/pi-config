/**
 * pi-memory — Tests: formatação da tool memory_search (resultados do índice).
 *
 * Garante o formato estável que o modelo consome quando a
 * busca vem do SQLite (engine primária). A tool em si exige a ExtensionAPI
 * do pi — aqui testa-se o formatador isolado.
 */

import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { formatIndexResults } from "../tools/search.ts";
import type { IndexSearchResult } from "../memory/memory-index.ts";

function result(overrides: Partial<IndexSearchResult> = {}): IndexSearchResult {
	return {
		path: "_global/gotchas/cache.md",
		scope: "global",
		projectId: null,
		type: "gotchas",
		context: "cache",
		title: "Cache invalidação",
		summary: null,
		confidence: 0.8,
		updated: "2026-08-01",
		retentionScore: 1.0,
		memoryId: "mem-1",
		snippet: "O bug era no cache",
		score: -1.23,
		...overrides,
	};
}

describe("formatIndexResults", () => {
	it("formata contagem, query, path, metadados, título e snippet", () => {
		const query = ["cache", "invalidação"];
		const text = formatIndexResults([result()], query);
		expect(text).toContain("Found 1 result(s):");
		expect(text).toContain(`Search query: ${JSON.stringify(query)}`);
		expect(text).toContain("memories/_global/gotchas/cache.md (0.8, 2026-08-01)");
		expect(text).toContain("tipo: gotchas · contexto: cache · escopo: global");
		expect(text).toContain("título: Cache invalidação");
		expect(text).toContain("trecho: O bug era no cache");
	});

	it("inclui resumo apenas quando existe", () => {
		const text = formatIndexResults([result({ summary: "Resumo curado" })]);
		expect(text).toContain("resumo: Resumo curado");
		const semResumo = formatIndexResults([result({ summary: null })]);
		expect(semResumo).not.toContain("resumo:");
	});

	it("omite trecho quando vazio", () => {
		const text = formatIndexResults([result({ snippet: "" })]);
		expect(text).not.toContain("trecho:");
	});

	it("lida com lista vazia", () => {
		expect(formatIndexResults([])).toContain("Found 0 result(s):");
	});

	it("múltiplos resultados: um bloco por memória", () => {
		const text = formatIndexResults([
			result(),
			result({ path: "projects/p1/lessons/x.md", scope: "project", type: "lessons", context: "x" }),
		]);
		expect(text).toContain("Found 2 result(s):");
		expect(text).toContain("memories/projects/p1/lessons/x.md");
	});
});

import {
	dispatchSearch,
	formatRgResults,
	hasMeaningfulTerm,
	registerMemorySearch,
} from "../tools/search.ts";
import type { ToolState } from "../tools/state.ts";
import type { SearchResult } from "../memory/memory-search.ts";

function rgResult(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		file: "/home/u/.pi/agent/memories/_global/gotchas/cache.md",
		lines: ["L7: O bug era no cache"],
		memoryId: null,
		...overrides,
	};
}

describe("hasMeaningfulTerm", () => {
	it("true quando ao menos um termo tem conteúdo", () => {
		expect(hasMeaningfulTerm(["cache", "  "])).toBeTrue();
		expect(hasMeaningfulTerm([" x "])).toBeTrue();
	});
	it("false quando todos os termos são vazios/espaços", () => {
		expect(hasMeaningfulTerm([])).toBeFalse();
		expect(hasMeaningfulTerm(["", "   "])).toBeFalse();
	});
});

describe("formatRgResults", () => {
	it("formata contagem, query, path relativo e linhas", () => {
		const query = ["cache", "invalidação"];
		const text = formatRgResults([rgResult()], query);
		expect(text).toContain("Found 1 result(s):");
		expect(text).toContain(`Search query: ${JSON.stringify(query)}`);
		expect(text).toContain("memories/_global/gotchas/cache.md");
		expect(text).toContain("L7: O bug era no cache");
	});
	it("trunca além de 5 linhas por arquivo", () => {
		const lines = Array.from({ length: 8 }, (_, i) => `L${i}: linha ${i}`);
		const text = formatRgResults([rgResult({ lines })]);
		expect(text).toContain("... 3 more matches");
	});
	it("lida com lista vazia", () => {
		expect(formatRgResults([])).toContain("Found 0 result(s):");
	});
});

describe("memory_search sem resultados", () => {
	it("exibe os termos usados na mensagem", async () => {
		type SearchTool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
		let capturedTool: SearchTool | undefined;
		const fakePi = {
			registerTool: (definition: SearchTool) => {
				capturedTool = definition;
			},
		};
		const state: ToolState = {
			projectId: `__test_search_terms_${Date.now()}`,
			currentSessionHash: "session",
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: null,
			pipeline: null,
			worker: null,
			retention: null,
			retentionScheduler: null,
		};
		registerMemorySearch(fakePi as never, state);
		if (!capturedTool) throw new Error("registerTool não capturou a definição");

		const terms = ["termo-inexistente", "palavra-improvável", "inlocalizável", "desconhecida", "incombinável"];
		const response = await capturedTool.execute("id", { query: terms, scope: "project" });
		expect(response.content[0].text).toContain(JSON.stringify(terms));
		expect(response.content[0].text).toContain("Attempts remaining before abandoning memory search: 4");

		const tooFew = await capturedTool.execute("id", { query: ["busca", "memória", "projeto", "contexto"] });
		expect(tooFew.content[0].text).toContain("at least 5 terms");
	});
});

describe("dispatchSearch", () => {
	it("SQLite ok → engine sqlite, sem primaryError", () => {
		const query = ["cache", "invalidação"];
		const d = dispatchSearch(
			() => [{ path: "a.md" } as IndexSearchResult],
			() => [rgResult()],
			query,
		);
		expect(d.engine).toBe("sqlite");
		expect(d.text).toContain(`Search query: ${JSON.stringify(query)}`);
		expect(d.count).toBe(1);
		expect(d.text).toContain("memories/a.md");
		expect(d.primaryError).toBeUndefined();
	});
	it("SQLite falha → fallback rg, engine rg-after-sqlite-error, primaryError", () => {
		const d = dispatchSearch(
			() => {
				throw new Error("sqlite locked");
			},
			() => [rgResult()],
		);
		expect(d.engine).toBe("rg-after-sqlite-error");
		expect(d.count).toBe(1);
		expect(d.text).toContain("memories/_global/gotchas/cache.md");
		expect(d.primaryError).toContain("sqlite locked");
	});
	it("SQLite e rg falham → lança erro combinado", () => {
		expect(() =>
			dispatchSearch(
				() => {
					throw new Error("sqlite broken");
				},
				() => {
					throw new Error("rg missing");
				},
			),
		).toThrow(/sqlite broken/);
	});
	it("SQLite falha e rg sem resultados → count 0, engine de fallback", () => {
		const d = dispatchSearch(
			() => {
				throw new Error("boom");
			},
			() => [],
		);
		expect(d.engine).toBe("rg-after-sqlite-error");
		expect(d.count).toBe(0);
		expect(d.text).toBe("");
	});
});
