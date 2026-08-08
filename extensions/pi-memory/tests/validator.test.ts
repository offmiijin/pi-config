/**
 * pi-memory — Tests: validação de candidatos, política e revisor (Fase 4,
 * módulo puro).
 */

import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";

import type { CandidateRecord } from "../pipeline.ts";
import {
	buildReviewPrompt,
	classifyCandidate,
	describeCandidate,
	looksLikePortuguese,
	parseReviewResponse,
	rejectionReason,
	validateCandidate,
	type MemoryFileRef,
} from "../validator.ts";

function makeCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
	return {
		id: "cand_1",
		jobId: "job_1",
		action: "create",
		context: "auth-session",
		type: "gotchas",
		scope: "project",
		title: "Sessão expira",
		summary: "Sessão expira após 1h de inatividade",
		content: "A sessão expira após 1h e o usuário perde o formulário aberto.",
		confidence: 0.8,
		evidenceIds: ["ev_1"],
		supersedes: null,
		status: "pending",
		rejectionReason: null,
		...overrides,
	};
}

const ctx = {
	existing: null,
	existingSupersedeTarget: null,
	validEvidenceIds: new Set(["ev_1"]),
};

const existing: MemoryFileRef = {
	context: "auth-session",
	scope: "project",
	type: "gotchas",
	confidence: 0.7,
	summary: "Versão antiga",
	content: "Versão antiga da memória.",
};

describe("validateCandidate", () => {
	it("candidato válido → sem issues", () => {
		expect(validateCandidate(makeCandidate(), ctx)).toHaveLength(0);
	});

	it("tipo inválido → erro", () => {
		const issues = validateCandidate(makeCandidate({ type: "gotcha" }), ctx);
		expect(issues.some((i) => i.code === "invalid_type")).toBeTrue();
		expect(issues[0].severity).toBe("error");
	});

	it("confidence < 0.5 → erro", () => {
		const issues = validateCandidate(makeCandidate({ confidence: 0.4 }), ctx);
		expect(issues.some((i) => i.code === "confidence")).toBeTrue();
	});

	it("sem evidence_ids → erro", () => {
		const issues = validateCandidate(makeCandidate({ evidenceIds: [] }), ctx);
		expect(issues.some((i) => i.code === "no_evidence")).toBeTrue();
	});

	it("evidence_id desconhecido → soft", () => {
		const issues = validateCandidate(makeCandidate({ evidenceIds: ["ev_999"] }), ctx);
		expect(issues.some((i) => i.code === "unknown_evidence" && i.severity === "soft")).toBeTrue();
	});

	it("create com context existente → erro", () => {
		const issues = validateCandidate(makeCandidate(), { ...ctx, existing });
		expect(issues.some((i) => i.code === "context_exists")).toBeTrue();
	});

	it("update sem memória existente → soft", () => {
		const issues = validateCandidate(makeCandidate({ action: "update" }), ctx);
		expect(issues.some((i) => i.code === "update_without_existing" && i.severity === "soft")).toBeTrue();
	});

	it("supersede sem target → erro; alvo inexistente → erro", () => {
		const noTarget = validateCandidate(makeCandidate({ action: "supersede", supersedes: null }), ctx);
		expect(noTarget.some((i) => i.code === "supersede_without_target")).toBeTrue();

		const missingTarget = validateCandidate(
			makeCandidate({ action: "supersede", supersedes: "outro-ctx" }),
			ctx,
		);
		expect(missingTarget.some((i) => i.code === "supersede_missing_target")).toBeTrue();
	});

	it("segredo no conteúdo → erro", () => {
		const issues = validateCandidate(
			makeCandidate({ content: "a chave sk-abcdefghijklmnopqrstuvwxyz123 vazou" }),
			ctx,
		);
		expect(issues.some((i) => i.code === "secret")).toBeTrue();
	});

	it("context não sanitizável → erro", () => {
		const issues = validateCandidate(makeCandidate({ context: "???" }), ctx);
		expect(issues.some((i) => i.code === "unsafe_context")).toBeTrue();
	});

	it("conteúdo gigante → erro", () => {
		const issues = validateCandidate(
			makeCandidate({ content: "x".repeat(10_001) }),
			ctx,
		);
		expect(issues.some((i) => i.code === "content_too_large")).toBeTrue();
	});
});

describe("classifyCandidate", () => {
	it("conf 0.8, project, sem issues → auto-accept", () => {
		expect(classifyCandidate(makeCandidate(), [], null)).toBe("auto-accept");
	});

	it("_rules → review", () => {
		expect(classifyCandidate(makeCandidate({ type: "_rules" }), [], null)).toBe("review");
	});

	it("global → review", () => {
		expect(classifyCandidate(makeCandidate({ scope: "global" }), [], null)).toBe("review");
	});

	it("supersede → review", () => {
		expect(classifyCandidate(makeCandidate({ action: "supersede", supersedes: "x" }), [], null)).toBe("review");
	});

	it("update com memória existente → review", () => {
		expect(classifyCandidate(makeCandidate({ action: "update" }), [], existing)).toBe("review");
	});

	it("confidence 0.6 → review", () => {
		expect(classifyCandidate(makeCandidate({ confidence: 0.6 }), [], null)).toBe("review");
	});

	it("issue soft → review", () => {
		const issues = [{ code: "ptbr", severity: "soft" as const, message: "m" }];
		expect(classifyCandidate(makeCandidate(), issues, null)).toBe("review");
	});

	it("issue error → reject; confidence 0.4 → reject", () => {
		const issues = [{ code: "no_evidence", severity: "error" as const, message: "m" }];
		expect(classifyCandidate(makeCandidate(), issues, null)).toBe("reject");
		expect(classifyCandidate(makeCandidate({ confidence: 0.4 }), [], null)).toBe("reject");
	});
});

describe("looksLikePortuguese", () => {
	it("texto PT → true; EN → false; neutro → true", () => {
		expect(looksLikePortuguese("A sessão não deveria expirar com o cache ativo")).toBeTrue();
		expect(looksLikePortuguese("the session should not expire with active cache")).toBeFalse();
		expect(looksLikePortuguese("zzzz qqqq")).toBeTrue();
	});
});

describe("rejectionReason", () => {
	it("junta mensagens de erro", () => {
		const reason = rejectionReason([
			{ code: "a", severity: "error", message: "erro 1" },
			{ code: "b", severity: "soft", message: "soft 1" },
			{ code: "c", severity: "error", message: "erro 2" },
		]);
		expect(reason).toContain("erro 1");
		expect(reason).toContain("erro 2");
		expect(reason).not.toContain("soft 1");
	});
});

describe("revisor (buildReviewPrompt / parseReviewResponse)", () => {
	it("prompt contém candidata, evidências e memória existente", () => {
		const prompt = buildReviewPrompt({
			candidate: describeCandidate(makeCandidate()),
			evidence: "- [correction] (id ev_1) não",
			existing: "versão antiga",
		});
		expect(prompt).toContain("Revise esta memória candidata");
		expect(prompt).toContain("auth-session");
		expect(prompt).toContain("ev_1");
		expect(prompt).toContain("versão antiga");
	});

	it("parseia accept/modify/reject", () => {
		expect(parseReviewResponse('{"action":"accept","reason":"ok"}')?.action).toBe("accept");
		const modify = parseReviewResponse('{"action":"modify","reason":"ajuste","modified":{"title":"Novo"}}');
		expect(modify?.action).toBe("modify");
		expect(modify?.modified?.title).toBe("Novo");
		expect(parseReviewResponse('{"action":"reject","reason":"ruim"}')?.action).toBe("reject");
	});

	it("inválido → null (fences e JSON quebrado)", () => {
		expect(parseReviewResponse("```json\n{\"action\":\"accept\",\"reason\":\"x\"}\n```")?.action).toBe("accept");
		expect(parseReviewResponse("não é json")).toBeNull();
		expect(parseReviewResponse('{"action":"aceitar","reason":"x"}')).toBeNull();
		expect(parseReviewResponse('{"action":"accept"}')).toBeNull(); // sem reason
	});
});
