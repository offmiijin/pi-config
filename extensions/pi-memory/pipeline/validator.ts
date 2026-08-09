/**
 * pi-memory — Validação de candidatos e revisor condicional (Fase 4, sem
 * dependência do PI). Módulo puro — testável standalone.
 *
 * - validateCandidate: checagens determinísticas (schema, evidência, ação ×
 *   estado atual, segredos, tamanho, PT-BR heurístico).
 * - classifyCandidate: política de aceitação (auto-accept | review | reject).
 * - buildReviewPrompt / parseReviewResponse: revisor condicional (mesmo
 *   modelo, reasoning low) para candidatos sensíveis (_rules, global,
 *   supersede, contradição, confiança intermediária).
 */

import type { CandidateRecord } from "./pipeline.ts";
import { hasSecret } from "./evidence.ts";
import { sanitizeFilename } from "../memory/memory.ts";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

/** Referência a uma memória existente (para dedup/contradição). */
export interface MemoryFileRef {
	context: string;
	scope: string;
	type: string;
	confidence: number;
	summary: string | null;
	content: string;
}

export interface ValidationIssue {
	code: string;
	severity: "error" | "soft";
	message: string;
}

export type CandidateDecision = "auto-accept" | "review" | "reject";

export interface ReviewDecision {
	action: "accept" | "modify" | "reject";
	reason: string;
	modified?: Partial<CandidateRecord>;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const MEMORY_TYPES_SET = new Set<string>(["_rules", "decisions", "gotchas", "lessons", "patterns"]);
export const MAX_CANDIDATE_CONTENT_CHARS = 10_000;

const PT_STOP = new Set([
	"não", "nao", "que", "com", "para", "uma", "dos", "das", "isso", "como",
	"mais", "mas", "por", "era", "tem", "ter", "está", "esta", "ser", "foi",
	"são", "sao", "quando", "onde", "também", "tambem", "então", "entao",
	"agora", "depois", "antes", "porque", "nada", "tudo", "sempre", "nunca",
	"fazer", "pode", "deve", "usar", "entre", "sobre", "após", "apos",
	"através", "atraves", "memória", "memoria", "sessão", "sessao", "arquivo",
	"código", "codigo", "sistema", "configuração", "configuracao", "implementação",
	"implementacao", "sem", "cada", "todo", "todos", "mesma", "mesmo", "outra",
	"outro", "muito", "pouco", "apenas", "ainda", "bem", "caso", "parte",
	"forma", "vez", "duas", "geral", "qual", "quais", "esse", "essa", "este",
	"esta", "seus", "suas", "delas", "deles", "desde", "durante", "enquanto",
]);

const EN_STOP = new Set([
	"the", "and", "with", "from", "that", "this", "are", "was", "were", "will",
	"have", "has", "had", "would", "should", "could", "about", "into", "through",
	"between", "during", "after", "before", "memory", "session", "file", "code",
	"system", "configuration", "implementation", "also", "because", "each",
	"than", "them", "then", "there", "these", "they", "those", "very", "when",
	"where", "which", "while", "your", "just", "like", "make", "more", "most",
	"only", "other", "over", "same", "some", "such", "their", "being", "been",
]);

/** Heurística leve: o texto parece PT-BR? Neutro (sem sinais) → true. */
export function looksLikePortuguese(text: string): boolean {
	const tokens = (text.toLowerCase().match(/[a-zà-úãõâêîôûç]+/g) ?? []).filter(
		(t) => t.length >= 3,
	);
	if (tokens.length === 0) return true;
	let pt = 0;
	let en = 0;
	for (const t of tokens) {
		if (PT_STOP.has(t)) pt++;
		else if (EN_STOP.has(t)) en++;
	}
	if (pt === 0 && en === 0) return true;
	return pt >= en;
}

/* ------------------------------------------------------------------ */
/* Validação determinística                                            */
/* ------------------------------------------------------------------ */

export function validateCandidate(
	c: CandidateRecord,
	ctx: {
		existing: MemoryFileRef | null;
		existingSupersedeTarget: MemoryFileRef | null;
		validEvidenceIds: Set<string>;
	},
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (!c.type || !MEMORY_TYPES_SET.has(c.type)) {
		issues.push({ code: "invalid_type", severity: "error", message: `tipo inválido: ${c.type}` });
	}
	if (c.scope !== "global" && c.scope !== "project") {
		issues.push({ code: "invalid_scope", severity: "error", message: `escopo inválido: ${c.scope}` });
	}
	if (!c.title || !c.title.trim()) {
		issues.push({ code: "empty_title", severity: "error", message: "título vazio" });
	}
	if (!c.content || !c.content.trim()) {
		issues.push({ code: "empty_content", severity: "error", message: "conteúdo vazio" });
	}
	if (c.summary && !c.summary.trim()) {
		issues.push({ code: "empty_summary", severity: "error", message: "summary vazio" });
	}

	const confidence = c.confidence ?? 0;
	if (confidence < 0.5 || confidence > 1) {
		issues.push({
			code: "confidence",
			severity: "error",
			message: `confidence ${confidence} fora de [0.5, 1]`,
		});
	}
	if ((c.content?.length ?? 0) > MAX_CANDIDATE_CONTENT_CHARS) {
		issues.push({
			code: "content_too_large",
			severity: "error",
			message: `conteúdo com ${c.content?.length} chars (max ${MAX_CANDIDATE_CONTENT_CHARS})`,
		});
	}
	if (!sanitizeFilename(c.context)) {
		issues.push({ code: "unsafe_context", severity: "error", message: `context não sanitizável: "${c.context}"` });
	}
	if (hasSecret(`${c.title ?? ""}\n${c.summary ?? ""}\n${c.content ?? ""}`)) {
		issues.push({ code: "secret", severity: "error", message: "segredo detectado no candidato" });
	}

	if (!c.evidenceIds || c.evidenceIds.length === 0) {
		issues.push({ code: "no_evidence", severity: "error", message: "sem evidence_ids" });
	} else {
		const missing = c.evidenceIds.filter((id) => !ctx.validEvidenceIds.has(id));
		if (missing.length > 0) {
			issues.push({
				code: "unknown_evidence",
				severity: "soft",
				message: `${missing.length} evidence_id(s) não encontrados no job`,
			});
		}
	}

	// Ação × estado atual
	if (c.action === "create" && ctx.existing) {
		issues.push({
			code: "context_exists",
			severity: "error",
			message: `context "${c.context}" já existe — use action update`,
		});
	}
	if (c.action === "update" && !ctx.existing) {
		issues.push({
			code: "update_without_existing",
			severity: "soft",
			message: "update sem memória existente — será tratado como create",
		});
	}
	if (c.action === "supersede") {
		if (!c.supersedes) {
			issues.push({ code: "supersede_without_target", severity: "error", message: "action supersede sem context alvo (supersedes)" });
		} else if (!ctx.existingSupersedeTarget) {
			issues.push({ code: "supersede_missing_target", severity: "error", message: `alvo do supersede não existe: "${c.supersedes}"` });
		}
	}

	if (!looksLikePortuguese(`${c.title ?? ""} ${c.summary ?? ""} ${c.content ?? ""}`)) {
		issues.push({ code: "ptbr", severity: "soft", message: "heurística: conteúdo pode não estar em PT-BR" });
	}

	return issues;
}

/* ------------------------------------------------------------------ */
/* Política de aceitação                                               */
/* ------------------------------------------------------------------ */

/**
 * Política (mapping 4.2): erro determinístico ou confidence < 0.5 → reject;
 * _rules/global/supersede/atualização de memória existente/soft issue/
 * confiança intermediária → review; o resto → auto-accept.
 */
export function classifyCandidate(
	c: CandidateRecord,
	issues: ValidationIssue[],
	existing: MemoryFileRef | null,
): CandidateDecision {
	if (issues.some((i) => i.severity === "error")) return "reject";
	const confidence = c.confidence ?? 0;
	if (confidence < 0.5) return "reject";

	if (c.type === "_rules") return "review";
	if (c.scope === "global") return "review";
	if (c.action === "supersede") return "review";
	if (c.action === "update" && existing) return "review";
	if (issues.some((i) => i.severity === "soft")) return "review";
	if (confidence < 0.75) return "review";
	return "auto-accept";
}

/** Motivo de rejeição (mensagens das issues de erro). */
export function rejectionReason(issues: ValidationIssue[]): string {
	const errors = issues.filter((i) => i.severity === "error");
	return errors.length > 0 ? errors.map((i) => i.message).join("; ") : "rejeitado pela política";
}

/* ------------------------------------------------------------------ */
/* Revisor condicional                                                 */
/* ------------------------------------------------------------------ */

/** Descreve o candidato para o revisor (texto). */
export function describeCandidate(c: CandidateRecord): string {
	return [
		`action: ${c.action}`,
		`context: ${c.context}`,
		`type: ${c.type ?? "-"}`,
		`scope: ${c.scope ?? "-"}`,
		`confidence: ${c.confidence ?? "-"}`,
		`title: ${c.title ?? "-"}`,
		`summary: ${c.summary ?? "-"}`,
		`content:\n${c.content ?? "-"}`,
	].join("\n");
}

/** Monta o prompt compacto do revisor (~3K tokens com evidências relevantes). */
export function buildReviewPrompt(opts: {
	candidate: string;
	evidence: string;
	existing: string | null;
}): string {
	return [
		"Revise esta memória candidata extraída de uma sessão de codificação.",
		"Decida: accept (aceitar como está), modify (aceitar com correções), ou reject (descartar).",
		"",
		opts.existing
			? `## Memória existente (mesmo context)\n\n${opts.existing}`
			: "## Memória existente\n\n(nenhuma)",
		`## Evidências relevantes\n\n${opts.evidence}`,
		`## Candidata\n\n${opts.candidate}`,
		"",
		"Critérios: conteúdo durável e não trivial; sem segredos; sem status temporário; PT-BR; evidência consistente; scope 'global' só se aplica a TODOS os projetos.",
		"",
		'Responda JSON apenas: {"action": "accept|modify|reject", "reason": "porquê em PT-BR", "modified": {"title": "...", "summary": "...", "content": "...", "confidence": 0.8, "scope": "project", "type": "gotchas"}}',
		'O campo "modified" é obrigatório quando action = modify (campos a corrigir).',
	].join("\n");
}

/** Interpreta a resposta do revisor (accept | modify | reject). */
export function parseReviewResponse(text: string): ReviewDecision | null {
	const cleaned = text
		.replace(/^```(?:json)?\s*/m, "")
		.replace(/\s*```$/m, "")
		.trim();
	try {
		const parsed = JSON.parse(cleaned) as {
			action?: unknown;
			reason?: unknown;
			modified?: unknown;
		};
		if (parsed.action !== "accept" && parsed.action !== "modify" && parsed.action !== "reject") {
			return null;
		}
		if (typeof parsed.reason !== "string") return null;
		const decision: ReviewDecision = { action: parsed.action, reason: parsed.reason };
		if (parsed.action === "modify" && parsed.modified && typeof parsed.modified === "object") {
			decision.modified = parsed.modified as Partial<CandidateRecord>;
		}
		return decision;
	} catch {
		return null;
	}
}
