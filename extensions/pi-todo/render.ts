/**
 * pi-todo — Formatação compartilhada
 *
 * Helpers de formatação usados pela renderização da tool.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoStatus } from "./types.ts";

/** Bolinha de status (símbolo constante; a cor varia por status). */
export const TODO_DOT = "●";

/** Cor do tema para cada status: cinza / amarelo / verde / amarelo para erro. */
export function statusColor(status: TodoStatus): "muted" | "warning" | "success" {
	switch (status) {
		case "pending":
			return "muted";
		case "in-progress":
			return "warning";
		case "done":
			return "success";
		case "error":
			return "warning";
		default:
			return "muted";
	}
}

/** Linha formatada: `● texto` com cores do tema atual. */
export function renderTodoLine(item: TodoItem, theme: Theme): string {
	const dot = theme.fg(statusColor(item.status), TODO_DOT);
	const text = item.status === "done" ? theme.fg("muted", item.text) : theme.fg("text", item.text);
	return `${dot} ${text}`;
}

/** Janela de cinco itens a partir da primeira tarefa ainda não concluída. */
export function visibleTodoItems(items: readonly TodoItem[], limit = 5): readonly TodoItem[] {
	const firstIncomplete = items.findIndex((item) => item.status !== "done");
	const start = firstIncomplete === -1 ? Math.max(0, items.length - limit) : firstIncomplete;
	return items.slice(start, start + limit);
}

/** Chave da mensagem que exibe o resumo final no histórico (estilo /doctor). */
export const TODO_REPORT_MESSAGE = "todo_report";

/** Texto puro do resumo final, exibido ao concluir todas as tarefas. */
export function buildCompletionReport(items: readonly TodoItem[]): string {
	const lines = [
		`✅ Todo — todas as ${items.length} tarefa(s) concluídas`,
		"",
		...items.map((t) => `✅ #${t.id} ${t.text}`),
		"",
		`Resumo: ${items.length} concluída(s)`,
	];
	return lines.join("\n");
}

/** Verdadeiro quando a lista tem itens e todos estão concluídos. */
export function isComplete(items: readonly TodoItem[]): boolean {
	return items.length > 0 && items.every((item) => item.status === "done");
}
