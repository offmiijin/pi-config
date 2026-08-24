/**
 * pi-todo — Reconstrução de estado a partir da sessão
 *
 * Leitura de snapshots persistidos em `tool result.details` e em entradas
 * custom, com reconstrução do estado em memória. Dados vindos da sessão
 * (JSON) não são confiáveis — todo snapshot é normalizado e validado contra
 * os invariantes de types.ts antes de ser aceito.
 */

import type { TodoItem, TodoState } from "./types.ts";
import { createTodoState, isTodoStatus } from "./state.ts";

// Normalização (dados estrangeiros)

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Normaliza um item vindo da sessão. Retorna `null` se qualquer campo for
 * inválido (id não-inteiro, texto vazio, status desconhecido, `error` sem
 * mensagem quando status é `error`).
 */
export function normalizeTodoItem(value: unknown): TodoItem | null {
	if (!isRecord(value)) return null;

	const { id, text, status, error } = value;
	if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
	if (typeof text !== "string" || text.trim() === "") return null;
	if (!isTodoStatus(status)) return null;

	if (status === "error") {
		if (typeof error !== "string" || error.trim() === "") return null;
		return { id, text, status, error: error.trim() };
	}
	return { id, text, status };
}

/**
 * Normaliza um snapshot completo (`{ items, nextId }`). Rejeita (retorna
 * `null`) snapshots que violam invariantes:
 * - `nextId` inválido ou `<=` maior id existente;
 * - ids duplicados;
 * - mais de um item `in-progress`.
 */
export function normalizeTodoState(value: unknown): TodoState | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.items)) return null;
	const { nextId } = value;
	if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1) return null;

	const items: TodoItem[] = [];
	const seen = new Set<number>();
	let maxId = 0;
	let inProgress = 0;

	for (const raw of value.items) {
		const item = normalizeTodoItem(raw);
		if (!item || seen.has(item.id)) return null;
		seen.add(item.id);
		items.push(item);
		maxId = Math.max(maxId, item.id);
		if (item.status === "in-progress") inProgress++;
	}

	if (inProgress > 1) return null;
	if (items.length > 0 && nextId <= maxId) return null;

	return { items, nextId };
}

// Reconstrução a partir do branch

/** Chave da entrada custom usada para persistir estado fora da tool (erro automático). */
export const TODO_STATE_ENTRY = "pi-todo-state";

/**
 * Forma mínima de entrada da sessão (compatível com o shape do SessionManager).
 * Tipos frouxos de propósito: dados da sessão não são confiáveis e o módulo
 * não depende do pi-coding-agent (testável de forma pura).
 */
export interface TodoSessionEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: {
		role?: unknown;
		toolName?: unknown;
		details?: unknown;
	};
}

/**
 * Reconstrói o estado percorrendo o branch atual e aplicando o ÚLTIMO
 * snapshot válido entre:
 * - tool results da tool `todo` (mutações via tool);
 * - entradas custom `pi-todo-state` (erro automático).
 * Entradas não relacionadas são ignoradas; snapshots corrompidos são pulados
 * (mantém o último válido). Sem snapshot válido → estado vazio.
 */
export function reconstructState(entries: readonly TodoSessionEntry[]): TodoState {
	let state: TodoState | null = null;

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (!msg || msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const normalized = normalizeTodoState(msg.details);
			if (normalized) state = normalized;
		} else if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY) {
			const normalized = normalizeTodoState(entry.data);
			if (normalized) state = normalized;
		}
	}

	return state ?? createTodoState();
}
