/**
 * pi-todo — Widget TUI acima do editor
 *
 * Fase 5: projeção das primeiras 5 tarefas com bolinhas coloridas.
 * O componente é uma projeção viva do holder: `render()` recalcula do estado
 * atual a cada renderização da TUI (sem cache), então nunca fica obsoleto.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderTodoLine } from "./render.ts";
import type { TodoState } from "./types.ts";

/** Chave do widget no `ctx.ui.setWidget`. */
export const WIDGET_ID = "pi-todo";

/** Máximo de tarefas exibidas no widget (não ocupar a tela toda). */
export const MAX_WIDGET_ITEMS = 5;

/**
 * Linhas do widget — projeção das primeiras 5 tarefas + indicador de
 * restantes. Lista vazia → sem linhas (widget colapsado).
 */
export function renderWidgetLines(state: TodoState, theme: Theme, width: number): string[] {
	if (state.items.length === 0) return [];

	const shown = state.items.slice(0, MAX_WIDGET_ITEMS);
	const lines = shown.map((item) => truncateToWidth(renderTodoLine(item, theme), width));

	if (state.items.length > MAX_WIDGET_ITEMS) {
		lines.push(truncateToWidth(theme.fg("dim", `+ ${state.items.length - MAX_WIDGET_ITEMS} mais`), width));
	}

	return lines;
}

/**
 * Componente do widget para `setWidget(WIDGET_ID, (_tui, theme) => ...)`.
 * `invalidate` é no-op: `render()` não usa cache.
 */
export function createTodoWidget(holder: { value: TodoState }, theme: Theme) {
	return {
		render: (width: number): string[] => renderWidgetLines(holder.value, theme, width),
		invalidate: (): void => {},
	};
}

/**
 * Atualização visual central (Fase 6):
 * - lista vazia → remove o widget (`setWidget(id, undefined)`);
 * - lista com tarefas → re-registra a projeção viva acima do editor.
 *
 * Deve ser chamada após TODA mutação de estado: add/update/clear (tool),
 * reconstrução de sessão/árvore e erro automático (Fase 7).
 */
export function updateTodoWidget(ctx: ExtensionContext, holder: { value: TodoState }): void {
	if (!ctx.hasUI) return;
	if (holder.value.items.length === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => createTodoWidget(holder, theme));
}
