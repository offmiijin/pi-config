/**
 * pi-memory — memory_extract tool.
 */

import { join, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORIES_ROOT } from "../constants.ts";
import { archiveSessionFile, getSessionFilePath, resetSessionFile } from "../session.ts";
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
			// Escrita altera o índice de memórias → invalida cache do system prompt
			state.cachedIndexText = null;
			if (!state.projectId || !state.currentSessionHash) {
				return {
					content: [{ type: "text", text: "Error: no active session" }],
					details: { error: "no_active_session" },
				};
			}

			// 1. Determine session file and read content
			// Sandbox: session_file é sempre resolvido dentro do diretório de
			// sessões do projeto atual. Paths absolutos ou com traversal (../)
			// são rejeitados — nunca operar em arquivos fora de sessions/.
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

			// Extração incremental: processa só o maior lote de observações que
			// cabe no orçamento de tokens. As não processadas permanecem no
			// arquivo — o LLM pode chamar memory_extract de novo até drenar.
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

			// 3. Save each memory — coleta falhas, não aborta no primeiro erro
			const saved: { context: string; action: string; error?: string }[] = [];
			const failures: string[] = [];
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
					}
				} catch (e: unknown) {
					const msg = (e as Error).message ?? String(e);
					saved.push({ context: mem.context, action: "error", error: msg });
					failures.push(`${mem.context}: ${msg}`);
				}
			}

			// Falha total — nenhuma memória salva: preserva TODAS as observações
			// do lote para re-tentativa limpa (sem risco de duplicar nada).
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

			// 4. Remove as observações processadas do arquivo de sessão.
			// Invariante: o arquivo só contém observações NÃO processadas —
			// re-extract nunca duplica. Falha parcial remove o lote mesmo assim
			// (memórias falhadas podem ser re-salvas via memory_save manual).
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

			// Backlog restante: não reseta — observações continuam no arquivo
			// para a próxima chamada. Trigger reinicia (próximo aos 50).
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

			// Sessão drenada: archive preserva o registro cru, reseta o arquivo
			// (mesmo hash, zero observações).
			const archivePath = archiveSessionFile(sessionFile);
			resetSessionFile(sessionFile, state.currentSessionHash);
			state.lastPromptedBucket = -1; // reinicia ciclo de trigger (próximo trigger às 50)

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
