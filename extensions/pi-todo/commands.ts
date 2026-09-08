/**
 * pi-todo — Comando /todos
 *
 * Lista COMPLETA de tarefas em tela temporária (além das 5 do widget).
 * Apenas visualização — não altera estado. Requer modo TUI (`ctx.ui.custom`
 * substitui o editor enquanto aberto).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderTodoLine } from "./render.ts";
import type { TodoToolState } from "./state.ts";

/** Componente de tela cheia: projeção viva do holder, Esc/Ctrl+C fecha. */
class TodoListComponent {
	private holder: TodoToolState;
	private theme: Theme;
	private onClose: () => void;

	constructor(holder: TodoToolState, theme: Theme, onClose: () => void) {
		this.holder = holder;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const items = this.holder.value.items;
		const lines: string[] = [];

		const title = ` ${th.fg("accent", th.bold(`Tarefas (${items.length})`))} `;
		const remaining = Math.max(0, width - visibleWidth(title) - 4);
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(remaining)),
				width,
			),
		);
		lines.push("");

		if (items.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "Lista vazia — use a tool todo para criar tarefas.")}`, width));
		} else {
			const done = items.filter((t) => t.status === "done").length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${items.length} concluídas`)}`, width));
			lines.push("");
			for (const item of items) {
				lines.push(truncateToWidth(`  ${renderTodoLine(item, th)}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Pressione Esc para fechar")}`, width));
		return lines;
	}

	invalidate(): void {
		// render() não usa cache — nada a invalidar.
	}
}

const TOGGLE_DEBOUNCE_MS = 250;

export function shouldToggleTodos(data: string, now: number, lastToggleAt: number): boolean {
	return matchesKey(data, Key.alt("t")) && !isKeyRepeat(data) && now - lastToggleAt >= TOGGLE_DEBOUNCE_MS;
}

export async function openTodos(holder: TodoToolState, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/todos requer modo interativo (TUI)", "error");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		return new TodoListComponent(holder, theme, () => done());
	});
}

export function registerTodosCommand(pi: ExtensionAPI, holder: TodoToolState): void {
	let removeTerminalInputListener: (() => void) | undefined;
	let lastToggleAt = Number.NEGATIVE_INFINITY;

	pi.registerCommand("todos", {
		description: "Mostra a lista completa de tarefas (to-do). Atalho: Alt+T",
		handler: async (_args, ctx) => openTodos(holder, ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		if (ctx.mode !== "tui") return;
		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.alt("t"))) return;
			const now = Date.now();
			if (shouldToggleTodos(data, now, lastToggleAt)) {
				lastToggleAt = now;
				void openTodos(holder, ctx);
			}
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
	});
}
