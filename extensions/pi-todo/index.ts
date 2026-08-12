/**
 * pi-todo — Entry point
 *
 * Composição da extensão. Fases seguintes registram aqui:
 * - Fase 4: tool única `todo` (mutações + snapshot em details);
 * - Fase 5: widget TUI acima do editor;
 * - Fase 7: detecção automática de erro (tool_execution_end);
 * - Fase 9: comando /todos.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reconstructState } from "./reconstruct.ts";
import { createTodoState } from "./state.ts";
import type { TodoState } from "./types.ts";

export default function (pi: ExtensionAPI) {
	// Estado em memória compartilhado entre tools, eventos e widget.
	let todoState: TodoState = createTodoState();

	const rebuildState = (ctx: ExtensionContext): void => {
		todoState = reconstructState(ctx.sessionManager.getBranch());
	};

	// Reconstrói o último snapshot válido do branch atual:
	// - /resume e reinício do pi → estado sobrevive;
	// - /fork e navegação de árvore → estado reflete o ponto da história.
	pi.on("session_start", async (_event, ctx) => rebuildState(ctx));
	pi.on("session_tree", async (_event, ctx) => rebuildState(ctx));
}
