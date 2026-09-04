/**
 * pi-memory — memory_read tool.
 *
 * Lê o markdown canônico completo de uma memória ativa. O índice é apenas
 * derivado; esta tool sempre lê a fonte da verdade no disco.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORIES_ROOT } from "../constants.ts";
import { listActiveMemoryFiles } from "../memory/memory-index.ts";
import { readFileMemoryId } from "../memory/memory-search.ts";
import { MemoryReadSchema } from "../schemas.ts";
import { recordSearchAccesses } from "./search.ts";
import type { ToolState } from "./state.ts";

type MemoryReadParams = {
	path: string;
};

/** Aceita o caminho exibido por memory_search ou o relativo a memories/. */
function normalizeMemoryPath(input: string): string | null {
	const path = input.trim();
	const relative = path.startsWith("memories/") ? path.slice("memories/".length) : path;
	if (
		relative.length === 0 ||
		relative.startsWith("/") ||
		relative.includes("\\") ||
		relative.split("/").some((part) => part === "." || part === ".." || part.length === 0)
	) {
		return null;
	}
	return relative;
}

export function registerMemoryRead(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description:
			"Reads the complete canonical Markdown of an active memory from disk (the source of truth). " +
			"Use after memory_search when its snippet or summary is not enough. " +
			"Pass the exact memories/... path returned by memory_search; never pass an absolute filesystem path. " +
			"NATIVE pi tool — call memory_read directly, NOT via mcp({ tool: 'memory_read' }) or the mcp gateway.",
		promptSnippet:
			"memory_read: Read the complete canonical memory markdown when search details are insufficient",
		promptGuidelines: [
			"Use memory_search first to locate the relevant memory and obtain its exact memories/... path.",
			"Call memory_read when the search snippet or summary is insufficient and the complete Markdown is needed.",
			"Pass the exact path returned by memory_search; the result includes frontmatter and the full current Markdown source of truth.",
			"Do not use memory_read indiscriminately: read only the relevant memories needed for the current task.",
		],
		parameters: MemoryReadSchema,

		async execute(_toolCallId, params: MemoryReadParams, _signal, _onUpdate, _ctx) {
			if (!state.projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}

			const relative = normalizeMemoryPath(params.path);
			if (!relative) {
				return {
					content: [{ type: "text", text: "Error: path must be a safe relative memory path" }],
					details: { error: "invalid_path" },
				};
			}

			const activePaths = new Set(listActiveMemoryFiles(state.projectId));
			if (!activePaths.has(relative)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: active memory not found for path "${params.path}"`,
						},
					],
					details: { error: "memory_not_found", path: relative },
				};
			}

			try {
				const filePath = join(MEMORIES_ROOT, relative);
				const markdown = readFileSync(filePath, "utf-8");
				recordSearchAccesses(state, [
					{ path: relative, memoryId: readFileMemoryId(filePath) },
				]);
				return {
					// Sem wrapper: preserva o markdown integral, incluindo frontmatter.
					content: [{ type: "text", text: markdown }],
					details: { path: relative, source: "markdown", complete: true },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error reading memory: ${(err as Error).message}` }],
					details: { error: "read_failed", path: relative },
				};
			}
		},
	});
}
