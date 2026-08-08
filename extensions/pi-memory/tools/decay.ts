/**
 * pi-memory — memory_decay tool.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relFromMemoriesRoot } from "../memory-index.ts";
import {
	applyDecay,
	findMemoryFile,
	formatFrontmatter,
	moveToSupersedes,
	parseFrontmatter,
} from "../memory.ts";
import { DecaySchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

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
			// Write changes the memory index → invalidate system prompt cache
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

			// Force move to .supersedes/
			if (move_to_supersedes) {
				const supPath = moveToSupersedes(filePath, {
					superseded_reason: reason,
				});
				// Sai do índice ativo (arquivo movido para .supersedes/)
				state.index?.removeDocument(relFromMemoriesRoot(filePath));
				return {
					content: [
						{
							type: "text",
							text: `Moved memory "${context}" to .supersedes/`,
						},
					],
					details: { action: "superseded", file: supPath, context },
				};
			}

			const newConf = applyDecay(currentConf, delta);

			// Confidence reached 0 — move to .supersedes/
			if (newConf <= 0) {
				const supPath = moveToSupersedes(filePath, {
					superseded_reason: reason,
				});
				state.index?.removeDocument(relFromMemoriesRoot(filePath));
				return {
					content: [
						{
							type: "text",
							text: `Confidence reached 0 — moved "${context}" to .supersedes/`,
						},
					],
					details: { action: "superseded", file: supPath, context },
				};
			}

			// Update confidence in place
			const today = new Date().toISOString().slice(0, 10);
			meta.confidence = newConf;
			meta.updated = today;
			writeFileSync(filePath, formatFrontmatter(meta) + body);
			state.index?.updateConfidence(relFromMemoriesRoot(filePath), newConf, today);

			return {
				content: [
					{
						type: "text",
						text: `Reduced confidence of "${context}" from ${currentConf} to ${newConf}`,
					},
				],
				details: { action: "decayed", file: filePath, context, confidence: newConf },
			};
		},
	});
}
