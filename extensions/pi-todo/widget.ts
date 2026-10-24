/**
 * pi-todo — Widget acima do editor
 *
 * Janela deslizante de até MAX_WIDGET_ITEMS tarefas a partir da primeira
 * ainda não concluída. Recriado via setWidget a cada mutação (por isso
 * invalidate é no-op); removido quando a lista esvazia (inclusive no
 * clear automático ao concluir todas as tarefas).
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderTodoLine, visibleTodoItems } from "./render.ts";
import type { TodoState } from "./types.ts";

export const WIDGET_ID = "pi-todo";
export const MAX_WIDGET_ITEMS = 5;

export function renderWidgetLines(state: TodoState, theme: Theme, width: number): string[] {
  if (state.items.length === 0) return [];
  const shown = visibleTodoItems(state.items, MAX_WIDGET_ITEMS);
  const lines = shown.map((item) => truncateToWidth(renderTodoLine(item, theme), width));
  const first = state.items.findIndex((item) => item.status !== "done");
  const start = first === -1 ? Math.max(0, state.items.length - MAX_WIDGET_ITEMS) : first;
  const remaining = state.items.length - start - shown.length;
  if (remaining > 0) lines.push(truncateToWidth(theme.fg("dim", `+ ${remaining} todos`), width));
  return lines;
}

export function createTodoWidget(holder: { value: TodoState }, theme: Theme) {
  return {
    render: (width: number): string[] => renderWidgetLines(holder.value, theme, width),
    // No-op: o widget é recriado via setWidget a cada mutação do estado.
    invalidate: (): void => {},
  };
}

export function updateTodoWidget(ctx: ExtensionContext, holder: { value: TodoState }): void {
  if (!ctx.hasUI) return;
  if (holder.value.items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(
    WIDGET_ID,
    (_tui, theme) => createTodoWidget(holder, theme),
    { placement: "aboveEditor" },
  );
}
