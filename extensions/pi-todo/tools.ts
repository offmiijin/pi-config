/**
 * pi-todo — Tool única
 *
 * Fase 4: tool `todo` com ações list/add/update/clear.
 * Estado é lido/gravado via holder compartilhado; cada resposta carrega o
 * snapshot completo em `details` (persistência — Fase 3). Execução sequencial
 * evita corrida entre chamadas irmãs do mesmo turno (ex.: add + update).
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderTodoLine } from "./render.ts";
import { addTodos, clearTodos, isTodoStatus, snapshot, updateTodo } from "./state.ts";
import { updateTodoWidget } from "./widget.ts";
import type { TodoAction, TodoDetails, TodoState, TodoStatus } from "./types.ts";

/** Estado compartilhado entre index (reconstrução) e tool (mutações). */
export interface TodoToolState {
	value: TodoState;
}

/**
 * Enum de strings compatível com Google API (mesmo shape do StringEnum do
 * pi-ai, sem a dependência — pi-ai não é hoisted neste repo).
 */
function stringEnum<T extends readonly string[]>(values: T) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

/** Parâmetro tipado (convenção do repo — typebox v1 não expõe Static). */
export interface TodoParamsInput {
	action: TodoAction;
	texts?: string[];
	id?: number;
	status?: TodoStatus;
	error?: string;
}

const TodoParams = Type.Object({
	action: stringEnum(["list", "add", "update", "clear"] as const),
	texts: Type.Optional(Type.Array(Type.String({ description: "Descrições das tarefas (add)" }))),
	id: Type.Optional(Type.Number({ description: "ID da tarefa (update)" })),
	status: Type.Optional(stringEnum(["pending", "in-progress", "done", "error"] as const)),
	error: Type.Optional(Type.String({ description: "Motivo da falha (update com status=error)" })),
});

/** Monta o snapshot completo persistido em `details`. */
function details(action: TodoAction, state: TodoState, error?: string): TodoDetails {
	const snap = snapshot(state);
	return { action, items: snap.items, nextId: snap.nextId, error };
}

interface TodoToolResult {
	content: { type: "text"; text: string }[];
	details: TodoDetails;
}

function ok(action: TodoAction, state: TodoState, text: string): TodoToolResult {
	return { content: [{ type: "text", text }], details: details(action, state) };
}

function fail(action: TodoAction, state: TodoState, message: string): TodoToolResult {
	return { content: [{ type: "text", text: `Erro: ${message}` }], details: details(action, state, message) };
}

function listText(state: TodoState): string {
	if (state.items.length === 0) return "Lista vazia — use add para criar tarefas.";
	return state.items
		.map((t) => {
			const reason = t.status === "error" && t.error ? ` (${t.error})` : "";
			return `#${t.id} [${t.status}] ${t.text}${reason}`;
		})
		.join("\n");
}

export function registerTodoTool(pi: ExtensionAPI, holder: TodoToolState): void {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Gerencia a lista de tarefas (to-do) da sessão, usada para dividir " +
			"trabalho extenso em etapas rastreáveis. Ações: list (estado atual), " +
			"add (texts: descrições), update (id + status, opcional error), " +
			"clear (limpa a lista).",
		promptSnippet: "Gerencia a lista de tarefas (to-do) da sessão: list, add, update, clear",
		promptGuidelines: [
			"Antes de executar uma tarefa extensa (muitas etapas, múltiplos arquivos ou diretórios), use a tool todo para dividir o trabalho em etapas concretas e rastreáveis.",
			"Marque a etapa em execução como in-progress via todo (update com id e status in-progress) antes de começar; apenas uma etapa pode ficar em execução por vez.",
			"Marque a etapa como done via todo (update com id e status done) somente após verificar que o resultado foi alcançado.",
			"Se não conseguir prosseguir em uma etapa, marque-a como error via todo (update com id, status error e o motivo) e explique o bloqueio ao usuário.",
			"Se uma ferramenta falhar durante a execução, a tool todo marca a etapa ativa como error automaticamente — retome usando todo update para in-progress ou pending quando corrigir o problema.",
			"Em conversas longas, use todo list para recuperar o contexto do que já foi feito e do que falta.",
			"Ao concluir todo o trabalho, use todo clear para limpar a lista e encerrar o rastreamento.",
		],
		parameters: TodoParams,
		executionMode: "sequential",

		async execute(_toolCallId, params: TodoParamsInput, _signal, _onUpdate, ctx) {
			const state = holder.value;

			switch (params.action) {
				case "list":
					return ok("list", state, listText(state));

				case "add": {
					const r = addTodos(state, params.texts ?? []);
					if (!r.ok) return fail("add", state, r.error!);
					holder.value = r.state;
					updateTodoWidget(ctx, holder);
					const added = r.added.map((t) => `#${t.id} ${t.text}`).join(", ");
					return ok("add", r.state, `Adicionadas ${r.added.length} tarefa(s): ${added}`);
				}

				case "update": {
					if (params.id === undefined) return fail("update", state, "update exige id");
					if (!isTodoStatus(params.status)) {
						return fail("update", state, "update exige status (pending, in-progress, done, error)");
					}
					const r = updateTodo(state, params.id, params.status, params.error);
					if (!r.ok) return fail("update", state, r.error!);
					holder.value = r.state;
					updateTodoWidget(ctx, holder);
					const label =
						r.updated!.status === "error" ? `error: ${r.updated!.error}` : r.updated!.status;
					return ok("update", r.state, `Tarefa #${params.id} → ${label}`);
				}

				case "clear": {
					const count = state.items.length;
					holder.value = clearTodos();
					updateTodoWidget(ctx, holder);
					return ok("clear", holder.value, `Lista limpa (${count} tarefa(s) removidas)`);
				}

				default:
					return fail("list", state, `ação desconhecida: ${String(params.action)}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (Array.isArray(args.texts) && args.texts.length > 0) {
				text += ` ${theme.fg("dim", args.texts.map((t) => `"${t}"`).join(", "))}`;
			}
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("muted", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Erro: ${details.error}`), 0, 0);

			if (details.action === "list") {
				if (details.items.length === 0) return new Text(theme.fg("dim", "Lista vazia"), 0, 0);
				const shown = expanded ? details.items : details.items.slice(0, 5);
				const lines = [
					theme.fg("muted", `${details.items.length} tarefa(s):`),
					...shown.map((t) => renderTodoLine(t, theme)),
				];
				if (!expanded && details.items.length > 5) {
					lines.push(theme.fg("dim", `... ${details.items.length - 5} mais`));
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
		},
	});
}
