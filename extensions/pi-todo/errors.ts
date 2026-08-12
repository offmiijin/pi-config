/**
 * pi-todo — Detecção automática de erro
 *
 * Fase 7: quando UMA FERRAMENTA falha (`tool_execution_end` com `isError`)
 * durante a execução de uma tarefa `in-progress`, a tarefa ativa é marcada
 * como `error` automaticamente — o modelo não conseguiu prosseguir na etapa.
 *
 * Política (Fase 12/Parte 8):
 * - erro da própria tool `todo` é operacional (parâmetros), não falha de
 *   etapa → nunca dispara esta marcação (evita recursão);
 * - ferramentas paralelas: marca ao PRIMEIRO erro observado; erros seguintes
 *   encontram a tarefa já em `error` (sem `in-progress`) e são ignorados;
 * - sem tarefa `in-progress` → nada a marcar.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TODO_STATE_ENTRY } from "./reconstruct.ts";
import { snapshot, updateTodo } from "./state.ts";
import type { TodoToolState } from "./tools.ts";
import { updateTodoWidget } from "./widget.ts";

/** Limita o texto do motivo extraído do resultado da ferramenta. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/** Extrai um motivo legível da falha: nome da ferramenta + 1º bloco de texto. */
function extractErrorText(toolName: string, result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	const blocks = Array.isArray(content) ? content : [];
	const first = blocks.find(
		(b): b is { type: string; text?: unknown } =>
			typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
	);
	const trimmed = typeof first?.text === "string" ? first.text.trim() : "";
	const brief = trimmed ? `: ${trimmed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}` : "";
	return `falha em ${toolName}${brief}`;
}

export function registerAutoError(pi: ExtensionAPI, holder: TodoToolState): void {
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.isError || event.toolName === "todo") return;

		const active = holder.value.items.findIndex((t) => t.status === "in-progress");
		if (active === -1) return;

		const r = updateTodo(
			holder.value,
			holder.value.items[active]!.id,
			"error",
			extractErrorText(event.toolName, event.result),
		);
		if (!r.ok) return;
		holder.value = r.state;

		// Persiste o novo snapshot (sobrevive a /resume e à navegação de árvore)
		// e reflete no widget acima do editor.
		pi.appendEntry(TODO_STATE_ENTRY, snapshot(r.state));
		updateTodoWidget(ctx, holder);
	});
}
