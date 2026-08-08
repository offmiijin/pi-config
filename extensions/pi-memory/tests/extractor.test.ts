/**
 * pi-memory — Tests: prompt de extração e parsing (Fase 3, módulo puro).
 */

import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";

import {
	buildEvidenceText,
	buildExtractionPrompt,
	extractSearchTerms,
	formatExistingMemories,
	parseExtractionResponse,
	type EvidenceBlock,
} from "../extractor.ts";

const cannedCandidate = {
	action: "create",
	context: "auth-session",
	type: "gotchas",
	scope: "project",
	title: "Sessão expira",
	summary: "Tokens de sessão expiram após 1h",
	content: "Sessão expira após 1h…",
	confidence: 0.8,
	evidence_ids: ["ev_abc"],
};

describe("buildEvidenceText", () => {
	it("agrupa por episódio e expõe os ids", () => {
		const blocks: EvidenceBlock[] = [
			{ id: "ev_1", episodeId: "ep_1", kind: "code-change", toolName: "edit", text: "edit /a.ts" },
			{ id: "ev_2", episodeId: "ep_1", kind: "command", toolName: "bash", text: "npm test" },
			{ id: "ev_3", episodeId: "ep_2", kind: "correction", toolName: null, text: "não" },
		];
		const text = buildEvidenceText(blocks);
		expect(text).toContain("## Episódio ep_1");
		expect(text).toContain("## Episódio ep_2");
		expect(text).toContain("(id ev_1)");
		expect(text).toContain("[code-change:edit]");
		expect(text).toContain("[correction]");
	});

	it("trunca quando estoura o orçamento", () => {
		const blocks: EvidenceBlock[] = [];
		for (let i = 0; i < 10; i++) {
			blocks.push({ id: `ev_${i}`, episodeId: "ep_1", kind: "response", toolName: null, text: "x".repeat(1000) });
		}
		const text = buildEvidenceText(blocks, 1); // ~4 chars de orçamento
		expect(text).toContain("truncadas");
		expect(text.length).toBeLessThan(blocks.length * 1000);
	});
});

describe("extractSearchTerms", () => {
	it("extrai paths e palavras frequentes, sem stopwords", () => {
		const blocks: EvidenceBlock[] = [
			{ id: "a", episodeId: "e", kind: "code-change", toolName: "edit", text: "edit /src/auth/session.ts" },
			{ id: "b", episodeId: "e", kind: "command", toolName: "bash", text: "teste falhou com session expirada session" },
			{ id: "c", episodeId: "e", kind: "response", toolName: null, text: "o problema era a sessão" },
		];
		const terms = extractSearchTerms(blocks);
		expect(terms).toContain("session");
		expect(terms.some((t) => t === "com" || t === "que" || t === "para")).toBeFalse();
		expect(terms.length).toBeLessThanOrEqual(10);
	});
});

describe("formatExistingMemories", () => {
	it("top 3 com snippet, resto com summary; vazio → ''", () => {
		expect(formatExistingMemories([])).toBe("");
		const memories = Array.from({ length: 5 }, (_, i) => ({
			scope: "project",
			type: "gotchas",
			context: `ctx-${i}`,
			confidence: 0.7,
			title: `Título ${i}`,
			summary: `Resumo ${i}`,
			snippet: `Trecho ${i}`,
		}));
		const text = formatExistingMemories(memories);
		expect(text).toContain("ctx-0");
		expect(text).toContain("Trecho 0"); // snippet no top 3
		expect(text).toContain("Resumo 4"); // summary nas demais
		expect(text).toContain("reutilize context keys");
	});
});

describe("buildExtractionPrompt", () => {
	it("monta prompt com sistema, memórias e evidências", () => {
		const prompt = buildExtractionPrompt({
			evidence: "## Evidências\n- [command] npm test",
			existingMemories: "- [project/gotchas/x] t",
		});
		expect(prompt).toContain("memórias duráveis");
		expect(prompt).toContain("## Memórias existentes");
		expect(prompt).toContain("## Evidências da sessão");
		expect(prompt).toContain("evidence_ids");
	});

	it("funciona sem memórias existentes", () => {
		const prompt = buildExtractionPrompt({ evidence: "vazio" });
		expect(prompt).not.toContain("## Memórias existentes");
	});
});

describe("parseExtractionResponse", () => {
	it("parseia JSON válido e separa ignore", () => {
		const text = JSON.stringify({
			memories: [
				cannedCandidate,
				{ ...cannedCandidate, context: "outro", action: "ignore" },
			],
		});
		const r = parseExtractionResponse(text);
		expect(r.candidates.length).toBe(1);
		expect(r.ignored).toBe(1);
		expect(r.candidates[0].context).toBe("auth-session");
		expect(r.candidates[0].evidence_ids).toEqual(["ev_abc"]);
	});

	it("remove code fences", () => {
		const r = parseExtractionResponse("```json\n" + JSON.stringify({ memories: [cannedCandidate] }) + "\n```");
		expect(r.candidates.length).toBe(1);
	});

	it("JSON inválido → vazio", () => {
		expect(parseExtractionResponse("não é json").candidates).toHaveLength(0);
		expect(parseExtractionResponse("").candidates).toHaveLength(0);
	});

	it("candidato sem context (schema inválido) → descartado", () => {
		const r = parseExtractionResponse(JSON.stringify({ memories: [{ ...cannedCandidate, context: "" }] }));
		expect(r.candidates).toHaveLength(0);
	});

	it("confidence fora de 0..1 → descartado", () => {
		const r = parseExtractionResponse(
			JSON.stringify({ memories: [{ ...cannedCandidate, confidence: 1.5 }] }),
		);
		expect(r.candidates).toHaveLength(0);
	});
});
