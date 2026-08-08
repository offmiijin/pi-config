/**
 * pi-memory — memory_extract tool.
 */

import { join, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORIES_ROOT } from "../constants.ts";
import { archiveSessionFile, getSessionFilePath, resetSessionFile } from "../session.ts";
import {
	readMemoryDocFromFile,
	relFromMemoriesRoot,
	type IndexDocument,
} from "../memory-index.ts";
import { saveMemory, summarizeExistingMemories } from "../memory.ts";
import {
	buildExtractionPrompt,
	parseExtractionResult,
	readSessionContent,
	removeProcessedObservations,
	selectObservationsBatch,
	splitObservations,
} from "../memory-extract.ts";
import { ExtractSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

export function registerMemoryExtract(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_extract",
		label: "Memory Extract",
		description:
			"Processes session observations into organized memories (incremental — one batch per call). " +
			"Reads the session file, identifies contexts, and saves memories via memory_save. " +
			"If observations remain after the call, call memory_extract again to drain the backlog. " +
			"Memories are written in PT-BR. " +
			"NATIVE pi tool — call memory_extract directly, NOT via mcp({ tool: 'memory_extract' }) or the mcp gateway.",
		promptSnippet:
			"memory_extract: Process session observations into memories",
		parameters: ExtractSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Write changes the memory index → invalidate system prompt cache
			state.cachedIndexText = null;
			if (!state.projectId || !state.currentSessionHash) {
				return {
					content: [{ type: "text", text: "Error: no active session" }],
					details: { error: "no_active_session" },
				};
			}

			// 1. Determine session file and read content
			// Sandbox: session_file is always resolved inside the current project's
			// sessions directory. Absolute paths or traversal (../)
			// are rejected — never operate on files outside sessions/.
			let sessionFile: string;
			if (params.session_file) {
				const sessionsDir = join(MEMORIES_ROOT, "projects", state.projectId, "sessions");
				const resolved = resolve(sessionsDir, params.session_file);
				if (resolved !== sessionsDir && resolved.startsWith(sessionsDir + "/")) {
					sessionFile = resolved;
				} else {
					return {
						content: [
							{
								type: "text",
								text:
									`Error: session_file "${params.session_file}" escapes the sessions directory. ` +
									"Use a relative path under sessions/ (e.g. '2026-08-05/abc123.md') or omit it to use the current session.",
							},
						],
						details: { error: "path_traversal", session_file: params.session_file },
					};
				}
			} else {
				sessionFile = getSessionFilePath(state.projectId, state.currentSessionHash);
			}

			const rawContent = readSessionContent(sessionFile);
			if (!rawContent.trim()) {
				return {
					content: [{ type: "text", text: "Session file is empty or missing." }],
					details: { error: "empty_session", session_file: sessionFile },
				};
			}

			// Incremental extraction: process only the largest batch of observations
			// that fits the token budget. Unprocessed ones stay in the
			// file — the LLM can call memory_extract again until drained.
			const observations = splitObservations(rawContent);
			if (observations.length === 0) {
				return {
					content: [
						{ type: "text", text: "Session file has no observations to extract." },
					],
					details: { error: "no_observations", session_file: sessionFile },
				};
			}
			const { batch, remaining } = selectObservationsBatch(observations);
			const sessionContent = batch.join("\n");

			// 2. Call LLM to analyze observations
			const model = ctx.model;
			if (!model) {
				return {
					content: [{ type: "text", text: "Error: no active model for extraction" }],
					details: { error: "no_model" },
				};
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth?.ok || !auth.apiKey) {
				return {
					content: [
						{
							type: "text",
							text: `Error: no API key for ${model.provider}/${model.id}`,
						},
					],
					details: { error: "no_api_key" },
				};
			}

			const existingMemories = summarizeExistingMemories(state.projectId);
			const prompt = buildExtractionPrompt(sessionContent, existingMemories);

			let responseText: string;
			try {
				const response = await complete(
					model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						reasoningEffort: "high",
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				);
				responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			} catch (e: unknown) {
				const msg = (e as Error).message ?? String(e);
				return {
					content: [{ type: "text", text: `Extraction LLM call failed: ${msg}` }],
					details: { error: msg },
				};
			}

			const memories = parseExtractionResult(responseText);
			if (memories.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Extraction produced no valid memories.",
						},
					],
					details: { count: 0 },
				};
			}

			// 3. Save each memory — collects failures, doesn't abort on the first error
			const saved: { context: string; action: string; error?: string }[] = [];
			const failures: string[] = [];
			// Acumula docs salvos + paths arquivados p/ sincronizar o índice em lote
			const docsToIndex: IndexDocument[] = [];
			const pathsToRemove: string[] = [];
			for (const mem of memories) {
				try {
					const result = saveMemory(state.projectId, {
						type: mem.type,
						context: mem.context,
						title: mem.title,
						content: mem.content,
						scope: mem.scope,
						confidence: mem.confidence ?? 0.5,
						tags: mem.tags ?? [],
						supersedes: mem.supersedes,
						mode: mem.mode,
						summary: mem.summary,
					});
					saved.push({
						context: mem.context,
						action: result.action,
						...(result.error ? { error: result.error } : {}),
					});
					if (result.action === "error") {
						failures.push(`${mem.context}: ${result.error}`);
					} else if (result.file) {
						// Falha de indexação não reverte o save — segue e avisa
						try {
							docsToIndex.push(
								readMemoryDocFromFile(result.file, relFromMemoriesRoot(result.file)),
							);
							for (const p of result.archived ?? []) pathsToRemove.push(relFromMemoriesRoot(p));
						} catch (err) {
							console.warn(
								`[pi-memory] extract: não leu ${result.file} p/ índice: ${(err as Error).message}`,
							);
						}
					}
				} catch (e: unknown) {
					const msg = (e as Error).message ?? String(e);
					saved.push({ context: mem.context, action: "error", error: msg });
					failures.push(`${mem.context}: ${msg}`);
				}
			}

			// Sincroniza o índice SQLite em lote (1 transação) — remove paths
			// arquivados (supersedes/consolidate) e upsert dos docs salvos.
			if ((docsToIndex.length > 0 || pathsToRemove.length > 0) && state.index?.isOpen) {
				try {
					state.index.syncMutation({ upsert: docsToIndex, remove: pathsToRemove });
				} catch (err) {
					console.warn(
						`[pi-memory] extract: índice não sincronizado: ${(err as Error).message}`,
					);
				}
			}

			// Total failure — no memory saved: preserves ALL observations
			// from the batch for a clean retry (no risk of duplicating anything).
			if (saved.length > 0 && saved.every((s) => s.action === "error")) {
				return {
					content: [
						{
							type: "text",
							text:
								`Extraction failed for all ${saved.length} memory(ies):\n` +
								`- ${failures.join("\n- ")}\n` +
								"Session observations preserved — fix the parameters and call memory_extract again.",
						},
					],
					details: {
						count: 0,
						saved,
						failures,
						reset: false,
					},
				};
			}

			// 4. Remove processed observations from the session file.
			// Invariant: the file only contains UNPROCESSED observations —
			// re-extract never duplicates. Partial failure still removes the batch
			// (failed memories can be re-saved manually via memory_save).
			removeProcessedObservations(sessionFile, batch.length);

			const summary = saved
				.filter((s) => s.action !== "error")
				.map((s) => `- ${s.action}: ${s.context}`)
				.join("\n");

			const failureNote =
				failures.length > 0
					? `\n\n${failures.length} memory(ies) FAILED (not saved):\n` +
						`- ${failures.join("\n- ")}\n` +
						"Save them manually via memory_save with the corrected parameters."
					: "";

			// Remaining backlog: don't reset — observations stay in the file
			// for the next call. Trigger restarts (next at 50).
			if (remaining.length > 0) {
				state.lastPromptedBucket = -1;
				return {
					content: [
						{
							type: "text",
							text:
								`Extracted ${saved.length - failures.length} memory(ies) from ${batch.length}/${observations.length} observations:\n${summary}${failureNote}\n` +
								`${remaining.length} observation(s) remaining — call memory_extract again to process the rest.`,
						},
					],
					details: {
						count: saved.length - failures.length,
						failures,
						saved,
						session_file: sessionFile,
						processed: batch.length,
						remaining: remaining.length,
						reset: false,
					},
				};
			}

			// Drained session: archive preserves the raw record, resets the file
			// (same hash, zero observations).
			const archivePath = archiveSessionFile(sessionFile);
			resetSessionFile(sessionFile, state.currentSessionHash);
			state.lastPromptedBucket = -1; // restarts trigger cycle (next trigger at 50)

			return {
				content: [
					{
						type: "text",
						text:
							`Extracted ${saved.length - failures.length} memory(ies) from ${sessionFile}:\n${summary}${failureNote}\nSession observations reset.`,
					},
				],
				details: {
					count: saved.length - failures.length,
					failures,
					saved,
					session_file: sessionFile,
					archive_file: archivePath,
					reset: true,
				},
			};
		},
	});
}
