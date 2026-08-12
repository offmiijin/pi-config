/**
 * pi-todo — Formatação compartilhada
 *
 * Fase 4: helpers de formatação usados pela renderização da tool (Fase 4)
 * e pelo widget TUI (Fase 5) — fonte única para cor da bolinha e da linha.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoStatus } from "./types.ts";

/** Bolinha de status (símbolo constante; a cor varia por status). */
export const TODO_DOT = "●";

/** Cor do tema para cada status: cinza / amarelo / verde / vermelho. */
export function statusColor(status: TodoStatus): "muted" | "warning" | "success" | "error" {
	switch (status) {
		case "pending":
			return "muted";
		case "in-progress":
			return "warning";
		case "done":
			return "success";
		case "error":
			return "error";
	}
}

/** Linha formatada: `● texto (motivo)` com cores do tema atual. */
export function renderTodoLine(item: TodoItem, theme: Theme): string {
	const dot = theme.fg(statusColor(item.status), TODO_DOT);
	const text = item.status === "done" ? theme.fg("muted", item.text) : theme.fg("text", item.text);
	const reason = item.status === "error" && item.error ? ` ${theme.fg("dim", `(${item.error})`)}` : "";
	return `${dot} ${text}${reason}`;
}
