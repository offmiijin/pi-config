/**
 * pi-memory — Tests: formatação da tool memory_search (resultados do índice).
 *
 * F6 (regressão): garante o formato estável que o modelo consome quando a
 * busca vem do SQLite (engine primária). A tool em si exige a ExtensionAPI
 * do pi — aqui testa-se o formatador isolado.
 */

import { describe, expect, it } from "bun:test";
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
