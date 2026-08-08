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
import type { IndexSearchResult } from "../memory-index.ts";

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
		snippet: "O bug era no cache",
		score: -1.23,
		...overrides,
	};
}

describe("formatIndexResults", () => {
	it("formata contagem, path, metadados, título e snippet", () => {
		const text = formatIndexResults([result()]);
		expect(text).toContain("Found 1 result(s):");
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
} from "../tools/search.ts";
import type { SearchResult } from "../memory-search.ts";

function rgResult(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		file: "/home/u/.pi/agent/memories/_global/gotchas/cache.md",
		lines: ["L7: O bug era no cache"],
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
	it("formata contagem, path relativo e linhas", () => {
		const text = formatRgResults([rgResult()]);
		expect(text).toContain("Found 1 result(s):");
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

describe("dispatchSearch", () => {
	it("SQLite ok → engine sqlite, sem primaryError", () => {
		const d = dispatchSearch(
			() => [{ path: "a.md" } as IndexSearchResult],
			() => [rgResult()],
		);
		expect(d.engine).toBe("sqlite");
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
