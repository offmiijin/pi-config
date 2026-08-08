/**
 * pi-memory — Ciclo de vida das observações de sessão (sem dependência do PI).
 *
 * Hashing de sessão, formatação/contagem de observações, dedup de turn,
 * estimativa de tokens e gestão do arquivo de sessão.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	CHARS_PER_TOKEN,
	MEMORIES_ROOT,
	OBSERVATION_THRESHOLD,
	OBSERVATION_TOKEN_BUDGETS,
} from "./constants.ts";

/**
 * Gera um hash curto e estável a partir do caminho do arquivo de sessão.
 */
export function hashSessionFile(sessionFile: string): string {
	return createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
}

/**
 * Gera um hash de sessão aleatório (sessões efêmeras sem arquivo).
 */
export function generateSessionHash(): string {
	return createHash("sha256")
		.update(`${Date.now()}_${Math.random()}`)
		.digest("hex")
		.slice(0, 12);
}

/**
 * Retorna o caminho do arquivo de sessão para projeto, data e hash.
 *
 * @param projectId   Identificador do projeto
 * @param sessionHash Hash de sessão de 12 caracteres
 * @param date        Data em YYYY-MM-DD (padrão: hoje)
 */
export function getSessionFilePath(projectId: string, sessionHash: string, date?: string): string {
	const d = date ?? new Date().toISOString().slice(0, 10);
	return join(MEMORIES_ROOT, "projects", projectId, "sessions", d, `${sessionHash}.md`);
}

/**
 * Extrai o texto concatenado do array de conteúdo de uma mensagem.
 * Lida com strings cruas e arrays de blocos.
 */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		}
	}
	return parts.join("\n").trim();
}

/**
 * Extrai nomes de tool calls do array de conteúdo de uma mensagem.
 */
export function extractToolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	const names: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "toolCall" && typeof b.name === "string") {
			names.push(b.name);
		}
	}
	return names;
}

/**
 * Formata a hora atual como HH:MM:SS.
 */
export function formatTimestamp(date?: Date): string {
	const d = date ?? new Date();
	return d.toTimeString().slice(0, 8);
}

/**
 * Formata a data/hora local atual como YYYY-MM-DD HH:MM:SS.
 */
export function formatDateTime(date?: Date): string {
	const d = date ?? new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Uma tool call com seu resultado, como registrada numa observação.
 */
export interface ToolObservation {
	name: string;
	result?: string;
	isError?: boolean;
}

/**
 * Referência de tool call extraída de uma mensagem do assistente.
 */
export interface ToolCallRef {
	id: string;
	name: string;
}

/**
 * Extrai tool calls (id + nome) do array de conteúdo de uma mensagem do assistente.
 */
export function extractToolCalls(content: unknown): ToolCallRef[] {
	if (!Array.isArray(content)) return [];

	const calls: ToolCallRef[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "toolCall" && typeof b.name === "string") {
			calls.push({ id: typeof b.id === "string" ? b.id : "", name: b.name });
		}
	}
	return calls;
}

/**
 * Extrai texto legível de um resultado de tool.
 * Lida com strings, arrays de blocos e formatos comuns.
 */
export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";

	const r = result as Record<string, unknown>;

	// Blocos de conteúdo: { content: [{ type: "text", text }] }
	if (Array.isArray(r.content)) {
		return extractTextContent(r.content);
	}
	if (typeof r.text === "string") return r.text;
	if (typeof r.output === "string") return r.output;

	return "";
}

/**
 * Estado persistente do dedup de turn (resetado por sessão).
 */
export interface TurnDedupState {
	lastTurnIndex: number | undefined;
	lastFingerprint: string;
}

export function createTurnDedupState(): TurnDedupState {
	return { lastTurnIndex: undefined, lastFingerprint: "" };
}

/**
 * Monta uma impressão digital da mensagem do assistente: ids de tool call
 * ordenados + texto. turn_end reemitidos para o mesmo turn produzem a
 * mesma impressão.
 */
export function buildTurnFingerprint(content: unknown): string {
	const ids = extractToolCalls(content)
		.map((tc) => tc.id)
		.sort()
		.join(",");
	return `${ids}|${extractTextContent(content)}`;
}

/**
 * Decide se um turn_end é duplicado do último turn processado.
 * Usa event.turnIndex (único por turn) quando disponível; senão cai para a
 * impressão digital do conteúdo. Funcional — retorna o estado atualizado.
 */
export function nextTurnDedup(
	turnIndex: number | undefined,
	fingerprint: string,
	state: TurnDedupState,
): { skip: boolean; state: TurnDedupState } {
	if (turnIndex !== undefined) {
		if (state.lastTurnIndex === turnIndex) return { skip: true, state };
		return {
			skip: false,
			state: { lastTurnIndex: turnIndex, lastFingerprint: fingerprint },
		};
	}
	if (fingerprint !== "" && fingerprint === state.lastFingerprint) {
		return { skip: true, state };
	}
	return { skip: false, state: { ...state, lastFingerprint: fingerprint } };
}

/**
 * Estima a contagem de tokens de um texto com heurística de chars por token.
 * Aproximação — não é um tokenizador real.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Trunca o texto para um orçamento máximo de tokens (estimado).
 * Adiciona marcador para o LLM saber que dados foram cortados.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
	const tokens = estimateTokens(text);
	if (tokens <= maxTokens) return text;

	const keepChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
	const kept = text.slice(0, keepChars);
	const omittedTokens = tokens - estimateTokens(kept);
	return `${kept}… [truncated: ~${omittedTokens} tokens omitted]`;
}

/**
 * Formata uma observação para append no arquivo de sessão.
 */
export function formatObservation(
	obsNumber: number,
	userPrompt: string,
	tools: ToolObservation[],
	agentResponse: string,
	timestamp?: Date,
): string {
	const time = formatTimestamp(timestamp);

	// Trunca textos longos para manter o arquivo legível.
	// Baseado em tokens, com marcador para o LLM saber que dados foram cortados.
	const promptPreview = truncateToTokens(userPrompt, OBSERVATION_TOKEN_BUDGETS.prompt);
	const responsePreview = truncateToTokens(agentResponse, OBSERVATION_TOKEN_BUDGETS.response);

	const lines = [
		"",
		`## Obs #${obsNumber} (${time})`,
		`User: "${promptPreview}"`,
	];

	if (tools.length === 0) {
		lines.push("Tools: (none)");
	} else {
		lines.push("Tools:");
		for (const t of tools) {
			const resultPreview = t.result
				? truncateToTokens(t.result, OBSERVATION_TOKEN_BUDGETS.toolResult)
				: "";
			const errorMark = t.isError ? "[error] " : "";
			if (resultPreview) {
				lines.push(`  ${t.name} → ${errorMark}"${resultPreview}"`);
			} else {
				lines.push(`  ${t.name}${errorMark ? " (error)" : ""}`);
			}
		}
	}

	if (responsePreview) {
		lines.push(`Agent: "${responsePreview}"`);
	} else {
		lines.push("Agent: (no response)");
	}

	return lines.join("\n");
}

/**
 * Conta observações existentes no arquivo de sessão.
 * Retorna 0 se o arquivo não existir ou não tiver observações.
 */
export function countObservations(filePath: string): number {
	if (!existsSync(filePath)) return 0;

	const content = readFileSync(filePath, "utf-8");
	// Âncora em início de linha + número — conteúdo com "## Obs #"
	// (ex.: markdown colado em texto de usuário/tool) não pode inflar a contagem.
	const matches = content.match(/^## Obs #\d+/gm);
	return matches ? matches.length : 0;
}

/**
 * Calcula o status de observações da sessão atual.
 * Retorna contagem, threshold e caminho do arquivo de sessão.
 */
export function getObservationStatus(
	projectId: string,
	sessionHash: string,
	date?: string,
): {
	observation_count: number;
	threshold: number;
	session_file: string;
} {
	const sessionFile = getSessionFilePath(projectId, sessionHash, date);
	const observationCount = countObservations(sessionFile);
	return {
		observation_count: observationCount,
		threshold: OBSERVATION_THRESHOLD,
		session_file: sessionFile,
	};
}

/**
 * Decide se deve emitir aviso de extração para a contagem atual, com base
 * no último bucket acionado. Dispara uma vez por cruzamento de threshold:
 * 50, 100, 150, ...
 *
 * @param count             contagem atual de observações
 * @param lastPromptedBucket último bucket que já acionou um aviso (-1 = nenhum)
 * @param threshold         limiar de observações
 */
export function shouldPromptExtraction(
	count: number,
	lastPromptedBucket: number,
	threshold: number = OBSERVATION_THRESHOLD,
): { prompt: boolean; bucket: number } {
	const bucket = Math.floor(count / threshold);
	return {
		prompt: count >= threshold && bucket > lastPromptedBucket,
		bucket,
	};
}

/** Tools que indicam mudança de código no turn (gatilho do lembrete de save). */
export const CODE_CHANGE_TOOLS = ["edit", "write", "apply_patch"] as const;

/** Mínimo de observações entre lembretes de save (cooldown para evitar ruído). */
export const SAVE_REMINDER_COOLDOWN = 5;

/**
 * Decide se deve emitir lembrete de save para a observação atual.
 * True quando o turn mudou código (edit/write/apply_patch) e passaram
 * observações suficientes desde o último lembrete.
 */
export function shouldRemindSave(
	toolNames: string[],
	obsNumber: number,
	lastReminderObs: number,
	cooldown: number = SAVE_REMINDER_COOLDOWN,
): boolean {
	const changedCode = toolNames.some((n) =>
		(CODE_CHANGE_TOOLS as readonly string[]).includes(n),
	);
	return changedCode && obsNumber - lastReminderObs >= cooldown;
}

/**
 * Monta o cabeçalho inicial do arquivo de sessão.
 */
export function formatSessionHeader(sessionHash: string, date?: string): string {
	const d = date ?? new Date().toISOString().slice(0, 10);
	return `# Session ${sessionHash} — ${d}`;
}

/**
 * Arquiva o conteúdo do arquivo de sessão antes do reset, preservando
 * observações cruas para re-extração futura. Retorna o caminho do arquivo.
 */
export function archiveSessionFile(filePath: string): string {
	const archivePath = join(dirname(filePath), "archive", basename(filePath));
	ensureFileDir(archivePath);
	if (existsSync(filePath)) {
		copyFileSync(filePath, archivePath);
	}
	return archivePath;
}

/**
 * Reseta o arquivo de sessão para o estado inicial (só cabeçalho, zero
 * observações). Mantém o mesmo caminho e hash de sessão.
 */
export function resetSessionFile(filePath: string, sessionHash: string): void {
	ensureFileDir(filePath);
	const header = formatSessionHeader(sessionHash);
	writeFileSync(filePath, header + "\n");
}

/**
 * Garante que o diretório do arquivo exista, criando se necessário.
 */
export function ensureFileDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
