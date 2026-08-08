/**
 * pi-memory — memory_save tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORY_LANGUAGE_RULE } from "../constants.ts";
import { readMemoryDocFromFile, relFromMemoriesRoot, type IndexDocument } from "../memory-index.ts";
import { saveMemory } from "../memory.ts";
import { SaveSchema } from "../schemas.ts";
import { syncIndex, type IndexStatus, type ToolState } from "./state.ts";

export function registerMemorySave(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Saves or updates a memory as a consolidated snapshot (Fase 5): same context key = same file, " +
			"every write rewrites the CURRENT state and archives the previous version to .history/. " +
			"The 'mode' parameter is deprecated — 'append' and 'consolidate' are equivalent now. " +
			"Provide 'summary' (1-2 sentences, PT-BR) describing the CURRENT state — it is persisted and updated on every write. " +
			"Use supersedes to mark a memory under a DIFFERENT context key as replaced. " +
			"NATIVE pi tool — call memory_save directly, NOT via mcp({ tool: 'memory_save' }) or the mcp gateway.",
		promptSnippet:
			"memory_save: Save/update a memory (same context = same file)",
		promptGuidelines: [
			MEMORY_LANGUAGE_RULE,
			"Before saving, call memory_search on the topic — reuse the existing context key if a memory already exists, or use supersedes if the new information contradicts it.",
			"After durable learnings — non-obvious bug fix, architectural decision, recurring gotcha, reusable pattern — call memory_save directly instead of waiting for background extraction.",
			"memory_save salva snapshot consolidado (estado atual apenas; versão anterior vai para .history/) — não append.",
			"Use supersedes to replace a memory that new information contradicts (different context key).",
			"Always provide 'summary' (1-2 sentences in PT-BR) describing the CURRENT state of the knowledge — it replaces the previous summary and is used by memory_extract for dedup.",
			"Only save with confidence >= 0.5.",
		],
		parameters: SaveSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Escrita muda o índice de memórias → invalida o cache do system prompt
			state.cachedIndexText = null;
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}

			// mode é legado (append = consolidate desde a Fase 5) — avisa e segue
			if (params.mode !== undefined) {
				console.warn(
					`[pi-memory] memory_save: parâmetro mode=${params.mode} é legado — toda escrita é snapshot (append e consolidate são equivalentes)`,
				);
			}

			const result = saveMemory(state.projectId, params);

			if (result.action === "error") {
				return {
					content: [{ type: "text", text: `Error saving memory: ${result.error}` }],
					details: result,
				};
			}

			// Sincroniza o índice SQLite — falha de indexação NÃO reverte a escrita
			// markdown (canônico); avisa e segue. Paths arquivados por
			// supersedes/consolidate saem da FTS na MESMA transação: a memória
			// antiga não continua buscável até o próximo sync incremental.
			let index: IndexStatus = "off";
			if (state.index?.isOpen) {
				try {
					const upsert: IndexDocument[] = [];
					const remove: string[] = [];
					if (result.file) {
						upsert.push(
							readMemoryDocFromFile(result.file, relFromMemoriesRoot(result.file)),
						);
					}
					for (const p of result.archived ?? []) remove.push(relFromMemoriesRoot(p));
					index = syncIndex(state, { upsert, remove });
				} catch (err) {
					index = "degraded";
					console.warn(
						`[pi-memory] save: índice não sincronizado (${result.file}): ${(err as Error).message}`,
					);
				}
			}

			const text =
				result.action === "created"
					? `Created memory: ${params.scope}/${params.type}/${params.context}`
					: `Consolidated memory (previous version archived to .history/): ${params.scope}/${params.type}/${params.context} (revision ${result.revision})`;

			return {
				content: [{ type: "text", text }],
				details: { ...result, index },
			};
		},
	});
}
