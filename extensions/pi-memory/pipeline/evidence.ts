/**
 * pi-memory — Normalização de evidências (sem dependência do PI).
 *
 * A partir de um episódio, lê o arquivo de
 * sessão JSONL do Pi, reconstrói o branch, classifica as entradas pela
 * matriz de relevância e insere `evidence` no pipeline. Nenhuma chamada LLM
 * aqui — só filtragem determinística.
 *
 * Regras centrais:
 * - tools de leitura/navegação (read/grep/find/ls/web_fetch) → descartadas
 * - tools de mutação (edit/write/apply_patch) → trecho do diff + path
 * - bash → comando + cauda do output; erro sobe de prioridade
 * - correção do usuário → evidência de alta prioridade
 * - thinking/images nunca entram no pipeline
 * - segredos são redigidos ([REDACTED]) antes de persistir
 * - dedup intra-episódio: mesma path editada de novo → só a última fica;
 *   repetição idêntica (mesmo tool+hash) → pula
 */

import { existsSync, readFileSync } from "node:fs";

import { CHARS_PER_TOKEN, OBSERVATION_TOKEN_BUDGETS } from "../constants.ts";
import { hashContent } from "../memory/memory-index.ts";
import {
	EPISODE_STATUS,
	type EpisodeRecord,
	type EpisodeStatus,
	type NewEvidence,
	type PipelineDB,
} from "./pipeline.ts";
import { estimateTokens } from "../session.ts";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

/** Subset do SessionEntry do Pi — o que a classificação precisa. */
export interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
	summary?: string;
}

/** Bloco de conteúdo (text/thinking/image/toolCall). */
interface ContentBlock {
	type: string;
	name?: string;
	id?: string;
	arguments?: unknown;
	text?: string;
}

/** Conteúdo principal de uma evidência (serializado em payload_json). */
export interface EvidencePayload {
	text: string;
	path?: string;
	command?: string;
	exitCode?: number;
}

/** Evidência extraída de um episódio (antes da inserção no banco). */
export interface ExtractedEvidence {
	kind: string;
	toolName?: string;
	entryId?: string;
	toolCallId?: string;
	payload: EvidencePayload;
	contentHash: string;
	isError: boolean;
	priority: number;
	redactionFlags: number;
	/** Chave de substituição intra-episódio (ex.: mesma path editada de novo). */
	dedupKey?: string;
}

/** Evidência classificada de um tool call (sem ids/hash — preenchidos na inserção). */
interface ClassifiedToolEvidence {
	kind: string;
	toolName?: string;
	payload: EvidencePayload;
	isError: boolean;
	priority: number;
	redactionFlags: number;
	dedupKey?: string;
}

/** Tipos de evidência produzidos pela classificação. */
export const EVIDENCE_KINDS = [
	"code-change",
	"command",
	"response",
	"prompt",
	"correction",
	"context",
	"memory-op",
	"research",
	"tool",
] as const;

/* ------------------------------------------------------------------ */
/* Leitura da sessão                                                   */
/* ------------------------------------------------------------------ */

/**
 * Lê o arquivo de sessão JSONL e devolve as entradas com id (o header
 * `{"type":"session"}` não tem id e é ignorado). Linhas corrompidas são
 * puladas — nunca derruba a normalização.
 */
export function readSessionEntries(sessionFile: string): SessionEntry[] {
	if (!existsSync(sessionFile)) return [];
	const raw = readFileSync(sessionFile, "utf-8");
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof parsed.id !== "string") continue;
		// O header da sessão ({"type":"session"}) também carrega id — mas não
		// faz parte da árvore (não representa interação nem tem parentId).
		if (parsed.type === "session") continue;
		const message = parsed.message;
		entries.push({
			type: typeof parsed.type === "string" ? parsed.type : "",
			id: parsed.id,
			parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
			timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
			message:
				message && typeof message === "object"
					? (message as SessionEntry["message"])
					: undefined,
			summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
		});
	}
	return entries;
}

/**
 * Reconstrói o branch da folha até a raiz (ordem root-first), seguindo a
 * cadeia parentId — equivalente a `SessionManager.getBranch(leafId)` do Pi.
 * Guarda contra loop em parentId corrompido.
 */
export function buildBranch(entries: SessionEntry[], leafId: string): SessionEntry[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const branch: SessionEntry[] = [];
	const guard = new Set<string>();
	let current: string | null = leafId;
	while (current && !guard.has(current)) {
		guard.add(current);
		const entry = byId.get(current);
		if (!entry) break;
		branch.unshift(entry);
		current = entry.parentId;
	}
	return branch;
}

/* ------------------------------------------------------------------ */
/* Sanitização                                                         */
/* ------------------------------------------------------------------ */

/** Padrões de segredo substituídos por [REDACTED]. */
const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic style keys
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
	/\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
	/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, // Authorization header
	/\b(?:api[_-]?key|token|secret|password|passwd|senha)\b\s*[:=]\s*["']?[^"' \n]{4,}/gi,
	// URL de conexão com credenciais embutidas: user:pass@host (qualquer
	// scheme) ou scheme de banco/mensageria com user@host. `ssh://git@` e
	// URLs públicas sem credenciais NÃO são segredos — ficam de fora.
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*:[^\s"'<>]*@[^\s"'<>]+/gi,
	/\b(?:postgres|postgresql|mysql|mariadb|mongodb|mongodb\+srv|redis|rediss|amqp|amqps|clickhouse):\/\/[^\s"'<>]+@[^\s"'<>]+/gi,
	// Chave privada PEM (multilinha).
	/-----BEGIN (?:RSA |EC |DSA |ENCRYPTED |OPENSSH )?PRIVATE KEY-----\s[\s\S]*?-----END (?:RSA |EC |DSA |ENCRYPTED |OPENSSH )?PRIVATE KEY-----/g,
	// Authorization header com Basic/Digest (base64 de user:pass).
	/\bauthorization\s*[:=]\s*(?:basic|digest)\s+[A-Za-z0-9+/=]{8,}\b/gi,
	// Basic standalone com token longo (base64 típico) — mínimo 16 chars
	// evita falsos positivos em texto comum ("basic template" tem 14).
	/\bbasic\s+[A-Za-z0-9+/=]{16,}\b/gi,
];

/** Substitui padrões de segredo; retorna texto limpo + flag de redação. */
export function sanitizeEvidenceText(text: string): { text: string; redacted: boolean } {
	let out = text;
	let redacted = false;
	for (const re of SECRET_PATTERNS) {
		out = out.replace(re, () => {
			redacted = true;
			return "[REDACTED]";
		});
	}
	return { text: out, redacted };
}

/** True se o texto contém algum padrão de segredo. */
export function hasSecret(text: string): boolean {
	// Não reusar SECRET_PATTERNS.some(re => re.test(text)): regex com flag `g`
	// é stateful (lastIndex avança entre chamadas) — o mesmo segredo alternaria
	// true/false. Delegar à sanitização (idempotente) evita o bug.
	return sanitizeEvidenceText(text).redacted;
}

function budgetChars(tokens: number): number {
	return tokens * CHARS_PER_TOKEN;
}

/** Trunca texto longo com marcador de tokens omitidos (estilo observações). */
export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const kept = text.slice(0, maxChars);
	const omitted = estimateTokens(text.slice(maxChars));
	return `${kept}\n… [truncated: ~${omitted} tokens omitted]`;
}

function snippet(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function lastLines(text: string, n: number): string {
	const lines = text.split("\n");
	return lines.slice(-n).join("\n");
}

/* ------------------------------------------------------------------ */
/* Extração de conteúdo                                                */
/* ------------------------------------------------------------------ */

/** Extrai texto de conteúdo (string ou blocos type:text). */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n").trim();
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	const out: ContentBlock[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (typeof b.type !== "string") continue;
		out.push({
			type: b.type,
			name: typeof b.name === "string" ? b.name : undefined,
			id: typeof b.id === "string" ? b.id : undefined,
			arguments: b.arguments,
			text: typeof b.text === "string" ? b.text : undefined,
		});
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
	if (typeof v === "string") return v;
	if (v === undefined || v === null) return "";
	return JSON.stringify(v);
}

/* ------------------------------------------------------------------ */
/* Matriz de relevância por tool                                       */
/* ------------------------------------------------------------------ */

/** Títulos de resultados de busca (negrito markdown ou linhas numeradas). */
function extractTitles(resultText: string): string {
	const titles: string[] = [];
	for (const m of resultText.matchAll(/\*\*(.+?)\*\*/g)) {
		const t = m[1].trim();
		if (t && !titles.includes(t)) titles.push(t);
		if (titles.length >= 5) break;
	}
	if (titles.length === 0) {
		return resultText
			.split("\n")
			.filter((l) => /^\s*\d+[.)]/.test(l))
			.slice(0, 5)
			.join("\n");
	}
	return titles.join("\n");
}

/**
 * Classifica um tool call segundo a matriz de relevância,
 * seção 1.3). Retorna null para tools descartadas (leitura/navegação).
 */
export function classifyToolCall(input: {
	name: string;
	args: Record<string, unknown>;
	resultText: string;
	isError: boolean;
}): ClassifiedToolEvidence | null {
	const { name, args, resultText, isError } = input;

	switch (name) {
		case "edit": {
			const path = sanitizeEvidenceText(str(args.path)).text;
			const edits = Array.isArray(args.edits) ? args.edits : [];
			const first = edits[0] as Record<string, unknown> | undefined;
			const oldText = first ? snippet(sanitizeEvidenceText(str(first.oldText)).text, 80) : "";
			const newText = first ? snippet(sanitizeEvidenceText(str(first.newText)).text, 80) : "";
			const { text, redacted } = sanitizeEvidenceText(
				[`edit ${path}`, oldText ? `old: ${oldText}` : "", newText ? `new: ${newText}` : ""]
					.filter(Boolean)
					.join("\n"),
			);
			return {
				kind: "code-change",
				toolName: "edit",
				payload: { text, path: path || undefined },
				isError,
				priority: 2,
				redactionFlags: redacted ? 1 : 0,
				dedupKey: `edit\0${str(args.path)}`,
			};
		}
		case "write": {
			const path = sanitizeEvidenceText(str(args.path)).text;
			const head = sanitizeEvidenceText(str(args.content)).text.split("\n").slice(0, 10).join("\n");
			const { text, redacted } = sanitizeEvidenceText(`write ${path}\n${head}`);
			return {
				kind: "code-change",
				toolName: "write",
				payload: { text, path: path || undefined },
				isError,
				priority: 2,
				redactionFlags: redacted ? 1 : 0,
				dedupKey: `write\0${str(args.path)}`,
			};
		}
		case "apply_patch": {
			const patch = str(args.patch) || str(args.content) || JSON.stringify(args);
			const { text, redacted } = sanitizeEvidenceText(snippet(patch, 300));
			return {
				kind: "code-change",
				toolName: "apply_patch",
				payload: { text },
				isError,
				priority: 2,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		case "bash": {
			const command = str(args.command);
			const tail = resultText ? lastLines(truncateText(resultText, budgetChars(OBSERVATION_TOKEN_BUDGETS.toolResult)), 8) : "";
			const { text, redacted } = sanitizeEvidenceText(
				[command, tail ? `\n${tail}` : ""].join(""),
			);
			return {
				kind: "command",
				toolName: "bash",
				// O campo `command` cru (com credenciais) NÃO pode ser persistido —
				// sanitiza separadamente do texto combinado.
				payload: { text, command: sanitizeEvidenceText(command).text, exitCode: isError ? 1 : undefined },
				isError,
				priority: isError ? 2 : 1,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		// Tools de leitura/navegação — descartadas (o conteúdo já esteve no
		// contexto do modelo; o transcript JSONL é a fonte bruta se precisar).
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "web_fetch":
			return null;
		case "web_search": {
			const titles = snippet(extractTitles(resultText), 500);
			const { text, redacted } = sanitizeEvidenceText(
				`query: ${snippet(str(args.query), 200)}\n${titles}`,
			);
			return {
				kind: "research",
				toolName: "web_search",
				payload: { text },
				isError,
				priority: 1,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		case "memory_save": {
			const raw = `type: ${str(args.type)} context: ${str(args.context)} title: ${str(args.title)} summary: ${str(args.summary)}`;
			const { text, redacted } = sanitizeEvidenceText(truncateText(raw, 500));
			return {
				kind: "memory-op",
				toolName: "memory_save",
				payload: { text },
				isError,
				priority: 1,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		case "memory_search": {
			const { text, redacted } = sanitizeEvidenceText(`query: ${str(args.query)}`);
			return {
				kind: "memory-op",
				toolName: "memory_search",
				payload: { text },
				isError,
				priority: 0,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		case "memory_read": {
			const { text, redacted } = sanitizeEvidenceText(`path: ${str(args.path)}`);
			return {
				kind: "memory-op",
				toolName: "memory_read",
				payload: { text },
				isError,
				priority: 0,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		case "memory_decay": {
			const raw = `context: ${str(args.context)} delta: ${str(args.delta)} reason: ${str(args.reason)}`;
			const { text, redacted } = sanitizeEvidenceText(raw);
			return {
				kind: "memory-op",
				toolName: "memory_decay",
				payload: { text },
				isError,
				priority: 1,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		case "memory_extract": {
			const { text, redacted } = sanitizeEvidenceText(truncateText(resultText, 300));
			return {
				kind: "memory-op",
				toolName: "memory_extract",
				payload: { text },
				isError,
				priority: 0,
				redactionFlags: redacted ? 1 : 0,
			};
		}
		default: {
			// Tool desconhecida (extensões etc.) — metadados + trecho pequeno.
			const argsText = truncateText(JSON.stringify(args), 300);
			const raw = isError
				? `${argsText}\n[error] ${truncateText(resultText, 200)}`
				: argsText;
			const { text, redacted } = sanitizeEvidenceText(raw);
			return {
				kind: "tool",
				toolName: name,
				payload: { text },
				isError,
				priority: isError ? 2 : 0,
				redactionFlags: redacted ? 1 : 0,
			};
		}
	}
}

/** Padrões que indicam correção/redirecionamento no prompt do usuário. */
const CORRECTION_PATTERNS: RegExp[] = [
	/\bnão\b/i, /\bnao\b/i, /\berrado\b/i, /\bcorrige\b/i, /\bcorrija\b/i,
	/\bmude\b/i, /\btroque\b/i, /\brevert(e)?\b/i, /\besquece\b/i,
	/\bna verdade\b/i, /\bnão é\b/i, /\bpare\b/i, /\bpara de\b/i,
	/\binstead\b/i, /\bactually\b/i, /\bwrong\b/i, /\bnot (that|this|correct|right)\b/i,
	/\bshould be\b/i, /\bchange it to\b/i, /\bfix it\b/i,
];

/* ------------------------------------------------------------------ */
/* Classificação do episódio                                           */
/* ------------------------------------------------------------------ */

/**
 * Classifica as entradas de um episódio em evidências. Processa em duas
 * passadas: primeiro coleta os toolResults (por toolCallId), depois percorre
 * as entradas produzindo evidências com dedup (repetição idêntica + mesma
 * path editada de novo → substitui a anterior).
 */
export function extractEpisodeEvidence(entries: SessionEntry[]): ExtractedEvidence[] {
	// Passada 1: resultados de tools por toolCallId
	const results = new Map<string, { text: string; isError: boolean }>();
	for (const entry of entries) {
		const msg = entry.message;
		if (!msg || msg.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
		const sanitized = sanitizeEvidenceText(extractText(msg.content));
		results.set(msg.toolCallId, { text: sanitized.text, isError: msg.isError === true });
	}

	const out: ExtractedEvidence[] = [];
	const seen = new Set<string>(); // `${kind}|${tool}|${hash}` — repetição idêntica

	const add = (ev: Omit<ExtractedEvidence, "contentHash">): void => {
		const contentHash = hashContent(JSON.stringify(ev.payload));
		const dedupId = `${ev.kind}|${ev.toolName ?? ""}|${contentHash}`;
		if (seen.has(dedupId)) return;
		seen.add(dedupId);

		if (ev.dedupKey) {
			// Mesmo alvo editado de novo → só a última evidência fica.
			for (let i = out.length - 1; i >= 0; i--) {
				if (out[i].dedupKey === ev.dedupKey) {
					out.splice(i, 1);
					break;
				}
			}
		}
		out.push({ ...ev, contentHash });
	};

	for (const entry of entries) {
		const msg = entry.message;

		// Entradas sem message: compaction/branch_summary → contexto resumido
		if (!msg) {
			if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string" && entry.summary.trim()) {
				const { text, redacted } = sanitizeEvidenceText(
					truncateText(entry.summary, budgetChars(300)),
				);
				add({
					kind: "context",
					entryId: entry.id,
					payload: { text },
					isError: false,
					priority: 0,
					redactionFlags: redacted ? 1 : 0,
				});
			}
			continue;
		}

		if (msg.role === "user") {
			const raw = truncateText(
				extractText(msg.content),
				budgetChars(OBSERVATION_TOKEN_BUDGETS.prompt),
			);
			if (!raw.trim()) continue;
			const isCorrection = CORRECTION_PATTERNS.some((re) => re.test(raw));
			const { text, redacted } = sanitizeEvidenceText(raw);
			add({
				kind: isCorrection ? "correction" : "prompt",
				entryId: entry.id,
				payload: { text },
				isError: false,
				priority: isCorrection ? 2 : 1,
				redactionFlags: redacted ? 1 : 0,
			});
			continue;
		}

		if (msg.role === "assistant") {
			const responseText = extractText(msg.content);
			if (responseText.trim()) {
				const { text, redacted } = sanitizeEvidenceText(
					truncateText(responseText, budgetChars(OBSERVATION_TOKEN_BUDGETS.response)),
				);
				add({
					kind: "response",
					entryId: entry.id,
					payload: { text },
					isError: false,
					priority: 1,
					redactionFlags: redacted ? 1 : 0,
				});
			}

			for (const block of contentBlocks(msg.content)) {
				if (block.type !== "toolCall") continue;
				const name = block.name ?? "unknown";
				const args = isObject(block.arguments) ? block.arguments : {};
				const result = block.id !== undefined ? results.get(block.id) : undefined;
				const classified = classifyToolCall({
					name,
					args,
					resultText: result?.text ?? "",
					isError: result?.isError ?? false,
				});
				if (!classified) continue;
				add({
					...classified,
					entryId: entry.id,
					toolCallId: block.id,
				});
			}
			continue;
		}

		// bashExecution e demais papéis — descartados
	}

	return out;
}

/* ------------------------------------------------------------------ */
/* Orquestração (episódio → pipeline)                                  */
/* ------------------------------------------------------------------ */

/** Converte evidência extraída em linha para o banco. */
export function toNewEvidence(episodeId: string, ev: ExtractedEvidence): NewEvidence {
	return {
		episodeId,
		entryId: ev.entryId,
		toolCallId: ev.toolCallId,
		kind: ev.kind,
		toolName: ev.toolName,
		payloadJson: JSON.stringify(ev.payload),
		contentHash: ev.contentHash,
		tokenEstimate: estimateTokens(ev.payload.text),
		redactionFlags: ev.redactionFlags,
		isError: ev.isError ? 1 : 0,
		priority: ev.priority,
	};
}

/** Resultado da normalização de um episódio. */
export interface NormalizeResult {
	episodeId: string;
	/** pending = adiado (arquivo ausente/ilegível/range não encontrado). */
	status: EpisodeStatus;
	inserted: number;
}

/**
 * Normaliza um episódio: lê a sessão, reconstrói o branch, classifica as
 * entradas e insere evidências em transação única.
 *
 * - Arquivo ausente/ilegível ou range não encontrado → mantém `pending`
 *   (o worker pode retentar; a sessão pode ainda não ter sido
 *   persistida no disco quando agent_settled dispara).
 * - Zero evidências → `ignored` (episódio ruidoso — nunca reanalisado).
 * - Com evidências → `normalized` (pronto para o worker).
 */
export function normalizeEpisode(
	pipeline: PipelineDB,
	episode: EpisodeRecord,
): NormalizeResult {
	if (!episode.sessionFile || !existsSync(episode.sessionFile)) {
		return { episodeId: episode.id, status: EPISODE_STATUS.PENDING, inserted: 0 };
	}

	let entries: SessionEntry[];
	try {
		entries = readSessionEntries(episode.sessionFile);
	} catch {
		return { episodeId: episode.id, status: EPISODE_STATUS.PENDING, inserted: 0 };
	}
	if (entries.length === 0) {
		return { episodeId: episode.id, status: EPISODE_STATUS.PENDING, inserted: 0 };
	}

	const branch = buildBranch(entries, episode.leafId);
	const startIdx = branch.findIndex((e) => e.id === episode.startEntryId);
	const endIdx = branch.findIndex((e) => e.id === episode.endEntryId);
	if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
		return { episodeId: episode.id, status: EPISODE_STATUS.PENDING, inserted: 0 };
	}

	const extracted = extractEpisodeEvidence(branch.slice(startIdx, endIdx + 1));
	const status: EpisodeStatus =
		extracted.length === 0 ? EPISODE_STATUS.IGNORED : EPISODE_STATUS.NORMALIZED;

	pipeline.finalizeEpisode(
		episode.id,
		extracted.map((ev) => toNewEvidence(episode.id, ev)),
		status,
	);
	return { episodeId: episode.id, status, inserted: extracted.length };
}

/**
 * Retry automático de episódios 'pending' de um projeto (Bloqueador 1).
 *
 * Episódios pendem quando o session JSONL ainda não estava persistido no
 * disco no momento do agent_settled. Esta função re-tenta a normalização de
 * todos os pendings — quando o arquivo já existe, eles transitam para
 * normalized/ignored; caso contrário permanecem pending (próximo retry).
 * Idempotente: episódios já em outro status não são tocados.
 */
export function normalizePendingEpisodes(
	pipeline: PipelineDB,
	projectId: string,
): { normalized: number; stillPending: number } {
	let normalized = 0;
	let stillPending = 0;
	for (const ep of pipeline.listEpisodesByStatus(projectId, EPISODE_STATUS.PENDING)) {
		const full = pipeline.getEpisode(ep.id);
		if (!full) continue;
		const r = normalizeEpisode(pipeline, full);
		if (r.status === EPISODE_STATUS.NORMALIZED || r.status === EPISODE_STATUS.IGNORED) {
			normalized++;
		} else {
			stillPending++;
		}
	}
	return { normalized, stillPending };
}
