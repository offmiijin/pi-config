/**
 * pi-todo — Entry point
 *
 * Composição da extensão. Fases seguintes registram aqui:
 * - Fase 5: widget TUI acima do editor;
 * - Fase 7: detecção automática de erro (tool_execution_end);
 * - Fase 9: comando /todos.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reconstructState } from "./reconstruct.ts";
import { createTodoState } from "./state.ts";
import { registerTodoTool, type TodoToolState } from "./tools.ts";
import { updateTodoWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
	// Estado em memória compartilhado entre tools, eventos e widget.
	const holder: TodoToolState = { value: createTodoState() };

	const rebuildState = (ctx: ExtensionContext): void => {
		holder.value = reconstructState(ctx.sessionManager.getBranch());
	};

	// Reconstrói o último snapshot válido do branch atual:
	// - /resume e reinício do pi → estado sobrevive;
	// - /fork e navegação de árvore → estado reflete o ponto da história.
	pi.on("session_start", async (_event, ctx) => {
		rebuildState(ctx);
		updateTodoWidget(ctx, holder);
	});
	pi.on("session_tree", async (_event, ctx) => {
		rebuildState(ctx);
		updateTodoWidget(ctx, holder);
	});

	registerTodoTool(pi, holder);
}
