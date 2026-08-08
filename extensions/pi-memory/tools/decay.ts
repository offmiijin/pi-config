/**
 * pi-memory — memory_decay tool.
 *
 * Semântica de falha de índice unificada com save/extract: o markdown é a
 * fonte da verdade e a operação canônica acontece primeiro; falha do índice
 * SQLite NUNCA transforma a operação já persistida em erro — apenas degrada
 * o índice (details.index = "degraded") e o próximo syncIncremental reconcilia.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMemoryDocFromFile, relFromMemoriesRoot } from "../memory-index.ts";
import {
	applyDecay,
	findMemoryFile,
	formatFrontmatter,
	moveToSupersedes,
	parseFrontmatter,
} from "../memory.ts";
import { DecaySchema } from "../schemas.ts";
import { syncIndex, type IndexStatus, type ToolState } from "./state.ts";

export function registerMemoryDecay(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_decay",
		label: "Memory Decay",
		description:
			"Reduces confidence of a memory or moves it to .supersedes/. " +
			"Call when a memory is obsolete or contradicted. " +
			"NATIVE pi tool — call memory_decay directly, NOT via mcp({ tool: 'memory_decay' }) or the mcp gateway.",
		promptSnippet:
			"memory_decay: Reduce confidence or supersede a memory",
		parameters: DecaySchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Escrita muda o índice de memórias → invalida o cache do system prompt
			state.cachedIndexText = null;
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}

			const { context, delta, move_to_supersedes, reason } = params;

			const filePath = findMemoryFile(state.projectId, context);
			if (!filePath) {
				return {
					content: [
						{
							type: "text",
							text: `No memory found for context "${context}"`,
						},
					],
					details: { error: "not_found", context },
				};
			}

			const content = readFileSync(filePath, "utf-8");
			const { meta, body } = parseFrontmatter(content);
			const currentConf = typeof meta.confidence === "number" ? meta.confidence : 0.5;

			// Move forçado para .supersedes/
			if (move_to_supersedes) {
				const supPath = moveToSupersedes(filePath, {
					superseded_reason: reason,
				});
				// Sai do índice ativo (arquivo movido para .supersedes/). Falha
				// de índice não reverte o movimento — o markdown já é canônico.
				const index = syncIndex(state, { upsert: [], remove: [relFromMemoriesRoot(filePath)] });
				return {
					content: [
						{
							type: "text",
							text: `Moved memory "${context}" to .supersedes/`,
						},
					],
					details: { action: "superseded", file: supPath, context, index },
				};
			}

			const newConf = applyDecay(currentConf, delta);

			// Confiança chegou a 0 — move para .supersedes/
			if (newConf <= 0) {
				const supPath = moveToSupersedes(filePath, {
					superseded_reason: reason,
				});
				const index = syncIndex(state, { upsert: [], remove: [relFromMemoriesRoot(filePath)] });
				return {
					content: [
						{
							type: "text",
							text: `Confidence reached 0 — moved "${context}" to .supersedes/`,
						},
					],
					details: { action: "superseded", file: supPath, context, index },
				};
			}

			// Atualiza a confiança no lugar. Reindexa o documento INTEIRO (corpo +
			// hash + metadados) — não apenas confidence: o markdown mudou e o
			// content_hash precisa acompanhar para o sync incremental não
			// reindexar à toa na próxima sessão. Falha de índice degrada e segue
			// (markdown já persistido).
			const today = new Date().toISOString().slice(0, 10);
			meta.confidence = newConf;
			meta.updated = today;
			writeFileSync(filePath, formatFrontmatter(meta) + body);
			let index: IndexStatus = "off";
			if (state.index?.isOpen) {
				try {
					const rel = relFromMemoriesRoot(filePath);
					index = syncIndex(state, {
						upsert: [readMemoryDocFromFile(filePath, rel)],
						remove: [],
					});
				} catch (err) {
					index = "degraded";
					console.warn(
						`[pi-memory] decay: índice não sincronizado (${filePath}): ${(err as Error).message}`,
					);
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `Reduced confidence of "${context}" from ${currentConf} to ${newConf}`,
					},
				],
				details: { action: "decayed", file: filePath, context, confidence: newConf, index },
			};
		},
	});
}
