/**
 * pi-todo — Modelo de dados e invariantes
 *
 * Contratos de mutação são validados em state.ts; aqui documentados como
 * invariantes que toda implementação deve respeitar.
 */

// Status

/** Status possíveis de uma tarefa. */
export const TODO_STATUSES = ["pending", "in-progress", "done", "error"] as const;

/**
 * Status de uma tarefa:
 * - `pending`     — não iniciado (bolinha cinza)
 * - `in-progress` — em execução (bolinha amarela)
 * - `done`        — concluído (bolinha verde)
 * - `error`       — modelo não conseguiu prosseguir (bolinha vermelha)
 */
export type TodoStatus = (typeof TODO_STATUSES)[number];

// Item

/**
 * Tarefa individual.
 *
 * Invariantes:
 * - `id` é único e monotônico; ids nunca são reutilizados dentro de um ciclo
 *   de lista (reiniciados apenas por `clear`).
 * - `status` é sempre um dos valores de `TODO_STATUSES`.
 * - `error` só deve existir quando `status === "error"`; ao sair de `error`,
 *   o campo deve ser removido.
 * - `text` não pode ser vazio (após trim).
 */
export interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
	error?: string;
}

// Estado

/**
 * Estado global da lista.
 *
 * Invariantes:
 * - `nextId` é sempre maior que o maior `id` existente em `items`.
 * - `items` preserva a ordem de criação; nunca é reordenado.
 * - No máximo UMA tarefa `in-progress` por vez. Iniciar um novo
 *   `in-progress` devolve o anterior para `pending`.
 * - Tarefa com `error` permanece na lista até ser atualizada ou a lista ser
 *   limpa.
 */
export interface TodoState {
	items: TodoItem[];
	nextId: number;
}

// Ações e payload persistido

/** Ações suportadas pela tool única `todo`. */
export type TodoAction = "list" | "add" | "update" | "clear";

/** Snapshot persistido em `tool result.details`. */
export interface TodoDetails {
	action: TodoAction;
	items: TodoItem[];
	nextId: number;
	error?: string;
}

// Regras de transição de status

/**
 * Transições permitidas de `status` (validadas em state.ts):
 *
 * - `pending`     → `in-progress` | `done` | `error`
 * - `in-progress` → `done` | `error` | `pending` (retrabalho)
 * - `done`        → `pending` | `in-progress` (reabrir)
 * - `error`       → `pending` | `in-progress` | `done` (tentar de novo)
 * - qualquer      → mesmo status (no-op)
 *
 * Regras de operação:
 * - `update` exige um `id` existente; id inexistente → erro de operação
 *   (não cria item novo).
 * - `add` rejeita `text` vazio; item sem texto → erro de operação.
 * - `clear` zera `items` e reinicia `nextId` em 1.
 */
