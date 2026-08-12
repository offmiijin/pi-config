/**
 * pi-todo — Entry point
 *
 * Composição da extensão: registra a tool `todo`, a detecção automática de
 * erro e o comando /todos; mantém o estado compartilhado e o reconstrói a
 * partir do branch atual da sessão.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTodosCommand } from "./commands.ts";
import { registerAutoError } from "./errors.ts";
import { reconstructState } from "./reconstruct.ts";
import { createTodoState, type TodoToolState } from "./state.ts";
import { registerTodoTool } from "./tools.ts";
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
	registerAutoError(pi, holder);
	registerTodosCommand(pi, holder);
}
