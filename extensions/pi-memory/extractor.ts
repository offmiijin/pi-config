/**
 * pi-memory — Prompt de extração e parsing da resposta (Fase 3, sem
 * dependência do PI). Módulo puro — testável standalone.
 *
 * Responsabilidades:
 * - formatar evidências (agrupadas por episódio, com id referenciável)
 * - extrair termos de busca para memórias relacionadas
 * - formatar memórias existentes (top 3 com trecho, resto com summary)
 * - montar o prompt (sistema + contexto + evidências + schema de saída)
 * - validar a resposta do modelo (TypeBox Check) e separar candidates/ignored
 */

import { CHARS_PER_TOKEN } from "./constants.ts";
import {
	EXTRACTION_MAX_EVIDENCE_TOKENS,
	EXTRACTION_MAX_MEMORY_CONTEXT_TOKENS,
} from "./config.ts";
import { Check } from "typebox/value";
import { ExtractionResponseSchema, type ExtractionCandidate } from "./schemas.ts";

/* ------------------------------------------------------------------ */
/* Evidências                                                          */
/* ------------------------------------------------------------------ */

/** Bloco de evidência pronto para o prompt (id referenciável pelo modelo). */
export interface EvidenceBlock {
	id: string;
	episodeId: string;
	kind: string;
	toolName: string | null;
	text: string;
	settledAt?: string;
}

/**
 * Formata blocos de evidência agrupados por episódio, com orçamento total.
 * Cada bloco carrega seu id (ev_xxx) — o modelo referencia em evidence_ids.
 */
export function buildEvidenceText(
	blocks: EvidenceBlock[],
	maxTokens: number = EXTRACTION_MAX_EVIDENCE_TOKENS,
): string {
	const maxChars = maxTokens * CHARS_PER_TOKEN;
	const byEpisode = new Map<string, EvidenceBlock[]>();
	for (const b of blocks) {
		const list = byEpisode.get(b.episodeId);
		if (list) list.push(b);
		else byEpisode.set(b.episodeId, [b]);
	}

	const lines: string[] = [];
	// Orçamento medido em CARACTERES (maxTokens × chars/token): soma direta
	// dos comprimentos — não re-estimar (estimar sobre estimativa permitia
	// ~4× o teto configurado).
	let total = 0;
	let truncated = false;
	for (const [episodeId, eps] of byEpisode) {
		const header = `## Episódio ${episodeId}`;
		if (total + header.length > maxChars && lines.length > 0) {
			truncated = true;
			break;
		}
		lines.push(header);
		total += header.length;
		for (const b of eps) {
			const label = b.toolName ? `${b.kind}:${b.toolName}` : b.kind;
			const line = `- [${label}] (id ${b.id}) ${b.text}`;
			if (total + line.length > maxChars) {
				truncated = true;
				break;
			}
			lines.push(line);
			total += line.length;
		}
		if (truncated) break;
	}
	if (truncated) lines.push("… [evidências excederam o orçamento — truncadas]");
	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Termos de busca para memórias relacionadas                          */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
	"about", "after", "again", "also", "being", "been", "before", "could", "does",
	"doing", "done", "each", "from", "have", "here", "into", "just", "like", "make",
	"made", "more", "most", "much", "must", "need", "only", "other", "over", "same",
	"some", "such", "than", "that", "their", "them", "then", "there", "these", "they",
	"this", "those", "through", "very", "want", "were", "what", "when", "where",
	"which", "while", "will", "with", "would", "your", "para", "com", "que", "uma",
	"uma", "das", "dos", "nas", "nos", "era", "ser", "tem", "ter", "está", "esta",
	"isso", "isto", "aqui", "não", "nao", "mais", "menos", "também", "tambem",
	"então", "entao", "agora", "depois", "antes", "porque", "como", "qual", "quais",
	"quando", "onde", "nada", "tudo", "algo", "outra", "outro", "mesmo", "mesma",
]);

/**
 * Extrai termos de busca determinísticos das evidências: paths de arquivos
 * (basename/stem) primeiro, depois palavras significativas mais frequentes.
 */
export function extractSearchTerms(blocks: EvidenceBlock[], maxTerms = 10): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	const addTerm = (raw: string): void => {
		const t = raw.toLowerCase().trim();
		if (t.length < 3 || t.length > 40 || seen.has(t)) return;
		seen.add(t);
		terms.push(t);
	};

	// Paths: "edit /a/b.ts", "write x.ts" → basename e partes
	const PATH_EXT = "ts|tsx|js|jsx|py|go|rs|java|rb|php|md|json|yml|yaml|css|html|sh";
	for (const b of blocks) {
		for (const m of b.text.matchAll(new RegExp(`\\b([A-Za-z0-9_.-]+)\\.(?:${PATH_EXT})\\b`, "g"))) {
			const stem = m[1].replace(/[_/-]/g, " ");
			for (const part of stem.split(" ")) addTerm(part);
		}
	}

	// Palavras significativas mais frequentes
	const freq = new Map<string, number>();
	for (const b of blocks) {
		for (const m of b.text.toLowerCase().matchAll(/[a-zà-ú]{5,}/g)) {
			const w = m[0];
			if (STOPWORDS.has(w)) continue;
			freq.set(w, (freq.get(w) ?? 0) + 1);
		}
	}
	for (const [w] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) addTerm(w);

	return terms.slice(0, maxTerms);
}

/* ------------------------------------------------------------------ */
/* Memórias existentes (contexto de dedup)                             */
/* ------------------------------------------------------------------ */

/** Referência a uma memória existente (projeção do índice/busca). */
export interface MemoryRef {
	scope: string;
	type: string;
	context: string;
	confidence: number;
	title: string;
	summary?: string | null;
	snippet?: string | null;
}

/**
 * Formata memórias relacionadas para o prompt: top 3 com trecho (snippet),
 * demais só com summary. Orçamento total limitado.
 */
export function formatExistingMemories(
	memories: MemoryRef[],
	maxTokens: number = EXTRACTION_MAX_MEMORY_CONTEXT_TOKENS,
): string {
	if (memories.length === 0) return "";
	const maxChars = maxTokens * CHARS_PER_TOKEN;

	const lines = [
		"Memórias existentes (reutilize context keys; action 'update' se a informação nova atualiza/contradiz a MESMA chave; 'supersedes' se substitui OUTRA chave):",
		"",
	];
	// Mesma regra do buildEvidenceText: orçamento em caracteres, soma direta
	// de lengths (evita ~4× o teto por re-estimar).
	let total = lines.join("\n").length;

	for (let i = 0; i < memories.length; i++) {
		const m = memories[i];
		let line = `- [${m.scope}/${m.type}/${m.context}] (conf ${m.confidence}) ${m.title}`;
		if (i < 3 && m.snippet) line += ` — ${m.snippet}`;
		else if (m.summary) line += ` — ${m.summary}`;
		if (total + line.length > maxChars) break;
		lines.push(line);
		total += line.length;
	}
	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const EXTRACTION_SYSTEM_INSTRUCTIONS = `Você extrai memórias duráveis de sessões de codificação de um agente.

Tipos de memória:
- _rules — convenções que devem SEMPRE ser seguidas
- decisions — decisões arquiteturais ou de design
- gotchas — armadilhas, erros, traps
- lessons — aprendizados que generalizam
- patterns — padrões recorrentes de código/design

Regras:
- Conteúdo em PT-BR (title, summary, content).
- Apenas memórias com confidence >= 0.5.
- Toda memória exige evidência: cite os ids (ev_...) das evidências usadas em evidence_ids. Nada além da evidência.
- Nunca inclua segredos/credenciais; nunca status temporário (progresso, "agora funciona", TODO); nunca cópia extensa de tool output; nada trivialmente redescobrível no código.
- scope "global" SÓ para conhecimento que aplica a TODOS os projetos; "project" para o restante.
- action "create" para contexto novo; "update" quando a informação nova atualiza/contradiz memória com a MESMA context key (reutilize a key); "supersedes" quando substitui memória de OUTRA key (informe a key em "supersedes"); "ignore" quando nada durável.
- Forneça "summary" (1-2 frases PT-BR) do estado ATUAL do conhecimento — persiste no frontmatter e serve de dedup futuro.
- Content: markdown rico e autocontido — não notas atômicas.
- Marcadores "[truncated: ~N tokens omitted]" significam dados cortados por orçamento — trate a evidência como parcial, nunca invente além deles.`;

/** Monta o prompt de extração (sistema + memórias existentes + evidências). */
export function buildExtractionPrompt(opts: {
	evidence: string;
	existingMemories?: string;
}): string {
	const parts = [
		EXTRACTION_SYSTEM_INSTRUCTIONS,
		opts.existingMemories ? `## Memórias existentes\n\n${opts.existingMemories}` : "",
		`## Evidências da sessão\n\n${opts.evidence}`,
		"",
		"Responda com JSON apenas, sem code fences:",
		'{"memories": [{"action": "create|update|supersede|ignore", "context": "chave-curta", "type": "gotchas|decisions|lessons|patterns|_rules", "scope": "global|project", "title": "título conciso", "summary": "1-2 frases PT-BR do estado atual", "content": "markdown rico autocontido", "confidence": 0.8, "evidence_ids": ["ev_..."], "supersedes": "chave-existente (opcional)", "reason": "por que é durável"}]}',
	];
	return parts.filter(Boolean).join("\n\n");
}

/* ------------------------------------------------------------------ */
/* Parsing da resposta                                                 */
/* ------------------------------------------------------------------ */

export interface ParsedExtraction {
	candidates: ExtractionCandidate[];
	ignored: number;
}

/**
 * Interpreta a resposta do modelo. Remove code fences, valida contra o schema
 * TypeBox e separa candidates (create/update/supersede) de ignores.
 * Resposta inválida → lista vazia (job é marcado done sem candidatos).
 */
export function parseExtractionResponse(text: string): ParsedExtraction {
	const cleaned = text
		.replace(/^```(?:json)?\s*/m, "")
		.replace(/\s*```$/m, "")
		.trim();
	if (!cleaned) return { candidates: [], ignored: 0 };

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		return { candidates: [], ignored: 0 };
	}
	if (!Check(ExtractionResponseSchema, parsed)) {
		return { candidates: [], ignored: 0 };
	}

	const memories = (parsed as { memories: ExtractionCandidate[] }).memories;
	const candidates = memories.filter((m) => m.action !== "ignore");
	const ignored = memories.length - candidates.length;
	return { candidates, ignored };
}
