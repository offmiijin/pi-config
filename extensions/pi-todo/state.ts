/**
 * pi-todo — Estado puro
 *
 * Fase 2: mutações imutáveis do estado da lista de tarefas.
 * Nenhuma função aqui acessa I/O, UI ou sessão — apenas dados.
 * Contratos de transição e invariantes documentados em types.ts.
 */

import type { TodoItem, TodoState, TodoStatus } from "./types.ts";
import { TODO_STATUSES } from "./types.ts";

// ---------------------------------------------------------------------------
// Construção e utilitários
// ---------------------------------------------------------------------------

/** Estado inicial vazio (mesma semântica de `clear`). */
export function createTodoState(): TodoState {
	return { items: [], nextId: 1 };
}

/** Type guard de status — valida parâmetros vindos da tool (JSON não confiável). */
export function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

/** Cópia profunda do estado — snapshot para persistência em `details`. */
export function snapshot(state: TodoState): TodoState {
	return {
		items: state.items.map((item) => ({ ...item })),
		nextId: state.nextId,
	};
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddTodosResult {
	ok: boolean;
	state: TodoState;
	added: TodoItem[];
	error?: string;
}

/**
 * Adiciona uma ou mais tarefas em `pending`.
 *
 * Invariantes:
 * - all-or-nothing: qualquer descrição vazia (após trim) rejeita a operação
 *   inteira, sem adicionar itens parciais.
 * - ids incrementais a partir de `state.nextId`; nunca reutilizados.
 */
export function addTodos(state: TodoState, texts: string[]): AddTodosResult {
	if (!Array.isArray(texts) || texts.length === 0) {
		return { ok: false, state, added: [], error: "add exige ao menos uma descrição" };
	}

	const cleaned = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
	const emptyIndex = cleaned.findIndex((t) => t === "");
	if (emptyIndex !== -1) {
		return { ok: false, state, added: [], error: `descrição vazia no item ${emptyIndex + 1}` };
	}

	const added = cleaned.map((text, i) => ({
		id: state.nextId + i,
		text,
		status: "pending" as const,
	}));

	return {
		ok: true,
		state: { items: [...state.items, ...added], nextId: state.nextId + added.length },
		added,
	};
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export interface UpdateTodoResult {
	ok: boolean;
	state: TodoState;
	updated?: TodoItem;
	error?: string;
}

/**
 * Atualiza o status de uma tarefa existente.
 *
 * Invariantes:
 * - `id` inexistente → erro de operação (não cria item novo).
 * - `error` exige mensagem; mensagem só é gravada quando status é `error`
 *   (e é removida ao sair de `error`).
 * - Iniciar um novo `in-progress` devolve o anterior para `pending`.
 * - Transições conforme matrix em types.ts (qualquer status → qualquer status
 *   permitido; mesmo status é no-op).
 */
export function updateTodo(
	state: TodoState,
	id: number,
	status: TodoStatus,
	errorMessage?: string,
): UpdateTodoResult {
	const index = state.items.findIndex((t) => t.id === id);
	if (index === -1) {
		return { ok: false, state, error: `tarefa #${id} não encontrada` };
	}
	if (!isTodoStatus(status)) {
		return { ok: false, state, error: `status inválido: ${String(status)}` };
	}
	if (status === "error" && (!errorMessage || errorMessage.trim() === "")) {
		return { ok: false, state, error: "status error exige descrição do motivo" };
	}

	const errorText = errorMessage?.trim();
	const items = state.items.map((item) => {
		if (item.id === id) {
			// Guard acima garante errorText não-vazio quando status === "error"
			return status === "error"
				? { id: item.id, text: item.text, status, error: errorText! }
				: { id: item.id, text: item.text, status };
		}
		// Inicia novo in-progress → anterior volta para pending (sem `error` residual)
		if (status === "in-progress" && item.status === "in-progress") {
			return { id: item.id, text: item.text, status: "pending" as const };
		}
		return item;
	});

	return { ok: true, state: { ...state, items }, updated: items[index] };
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

/** Zera a lista e reinicia `nextId` em 1. */
export function clearTodos(): TodoState {
	return { items: [], nextId: 1 };
}
