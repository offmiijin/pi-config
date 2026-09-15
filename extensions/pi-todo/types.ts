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
 * - `error`       — modelo não conseguiu prosseguir (cor neutra/amarela)
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
 * - As tarefas são executadas estritamente na ordem de criação.
 * - Somente a primeira tarefa que não está `done` pode ser atualizada.
 * - Tarefas posteriores permanecem `pending` até as anteriores terminarem.
 * - Tarefa com `error` permanece na lista e bloqueia as seguintes até ser
 *   corrigida ou a lista ser limpa.
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
 * - a primeira tarefa pendente/erro → `in-progress` | `done` | `error`
 * - a tarefa em `in-progress` → `done` | `error` | `pending`
 * - a tarefa em `error` → `pending` | `in-progress` | `done`
 * - `done` → somente `done` (no-op; tarefas concluídas não reabrem)
 * - qualquer → mesmo status (no-op), respeitando a ordem
 *
 * Regras de operação:
 * - `update` exige um `id` existente; id inexistente → erro de operação
 *   (não cria item novo).
 * - `add` rejeita `text` vazio; item sem texto → erro de operação.
 * - `clear` zera `items` e reinicia `nextId` em 1.
 */
