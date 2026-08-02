/**
 * pi-memory — Memory extension for PI coding agent.
 *
 * Manages persistent memories (rules, decisions, gotchas, lessons, patterns)
 * across global and project scopes. Memories are rich markdown files grouped
 * by context, searchable via ripgrep.
 *
 * The LLM drives all memory operations via tools. The extension only appends
 * raw observations to the session file automatically at turn_end.
 *
 * Parts:
 *   1. [x] Scaffold — directories, project ID, session lifecycle
 *   2. [x] Append observations at turn_end
 *   3. [x] Register 5 tools (scaffold with stubs)
 *   4. [x] memory_save — persist/update markdown files
 *   5. [x] memory_search — ripgrep wrapper
 *   6. [x] memory_status — observation counter
 *   7. [x] memory_decay — confidence reduction / supersede
 *   8. [x] memory_extract — process session file via LLM
 *   9. [x] Skill with usage instructions
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyDecay,
	buildExtractionPrompt,
	buildSearchPattern,
	countObservations,
	ensureDirectories,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	extractToolCalls,
	findMemoryFile,
	type ToolObservation,
	formatFrontmatter,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	getObservationStatus,
	getSessionFilePath,
	hashSessionFile,
	identifyProject,
	MAX_MEMORY_SEARCH_ATTEMPTS,
	MEMORIES_ROOT,
	MEMORY_LANGUAGE_RULE,
	moveToSupersedes,
	OBSERVATION_THRESHOLD,
	parseExtractionResult,
	parseFrontmatter,
	readSessionContent,
	resetSessionFile,
	saveMemory,
	SAVE_REMINDER_COOLDOWN,
	searchMemories,
	shouldPromptExtraction,
	shouldRemindSave,
} from "./utils.ts";
import {
	DecaySchema,
	ExtractSchema,
	SaveSchema,
	SearchSchema,
	StatusSchema,
} from "./schemas.ts";

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Runtime state (per session, reset on reload)
	let projectId = "";
	let currentSessionHash = "";
	// Auto-extraction trigger state
	let lastPromptedBucket = -1;
	let extractionDueCount = 0;
	// Memory search policy state (consecutive empty searches)
	let consecutiveEmptySearches = 0;
	// Save reminder state (code-changing turns)
	let saveReminderDue = false;
	let lastSaveReminderObs = 0;
	// Buffer de resultados de tools do turno atual (toolCallId → observação)
	const toolResultsBuffer = new Map<string, ToolObservation>();

	// ── Captura resultados de tools durante o turno ───────────────────────
	pi.on("tool_result", async (event) => {
		const e = event as unknown as {
			toolCallId?: string;
			toolName?: string;
			content?: unknown;
			isError?: boolean;
		};
		if (!e.toolCallId) return;
		toolResultsBuffer.set(e.toolCallId, {
			name: e.toolName ?? "unknown",
			result: extractTextContent(e.content),
			isError: !!e.isError,
		});
	});

	// ── Session lifecycle ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);
		ensureDirectories(projectId);

		const sessionFile = ctx.sessionManager.getSessionFile();
		currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();

		// Reset auto-extraction trigger state
		lastPromptedBucket = -1;
		extractionDueCount = 0;
		// Reset memory search policy state
		consecutiveEmptySearches = 0;
		// Reset save reminder state
		saveReminderDue = false;
		lastSaveReminderObs = 0;
	});

	pi.on("session_tree", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);

		// Reset trigger state on branch navigation
		lastPromptedBucket = -1;
		extractionDueCount = 0;
		// Reset memory search policy state
		consecutiveEmptySearches = 0;
		// Reset save reminder state
		saveReminderDue = false;
		lastSaveReminderObs = 0;
	});

	// ── Append observations at turn_end ────────────────────────────────────
	pi.on("turn_end", async (event, ctx) => {
		if (!projectId || !currentSessionHash) return;

		const assistantMsg = event.message;
		if (!assistantMsg) return;

		const branch = ctx.sessionManager.getBranch();

		// Encontra o último prompt do usuário e coleta resultados de tools
		// do turno atual (mensagens role="toolResult" após o último prompt)
		let userPrompt = "";
		let lastUserIdx = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "user") {
				lastUserIdx = i;
				userPrompt = extractTextContent(entry.message.content);
				break;
			}
		}

		// Tool calls do conteúdo do assistant (ordem de origem)
		const toolCalls = extractToolCalls(assistantMsg.content);

		// Resultados deste turno a partir do branch (mensagens role="toolResult"
		// após o último user — também em ordem de origem, conforme documentado)
		const branchResults: ToolObservation[] = [];
		if (lastUserIdx >= 0) {
			for (let i = lastUserIdx + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message?.role === "toolResult") {
					branchResults.push({
						name: entry.message.toolName ?? "unknown",
						result: extractTextContent(entry.message.content),
						isError: !!entry.message.isError,
					});
				}
			}
		}

		// Alinha toolCalls[i] ↔ branchResults[i]; buffer enriquece por id
		let toolResults: ToolObservation[];
		if (toolCalls.length > 0) {
			toolResults = toolCalls.map((tc, i) => {
				const buffered = toolResultsBuffer.get(tc.id);
				if (buffered && buffered.result) return buffered;
				return branchResults[i] ?? { name: tc.name };
			});
		} else {
			// Sem toolCall blocks no conteúdo: usa branchResults direto
			toolResults =
				branchResults.length > 0
					? branchResults
					: extractToolCallNames(assistantMsg.content).map((n) => ({ name: n }));
		}
		toolResultsBuffer.clear();

		const agentResponse = extractTextContent(assistantMsg.content);

		const sessionFile = getSessionFilePath(projectId, currentSessionHash);
		ensureFileDir(sessionFile);

		if (!existsSync(sessionFile)) {
			const header = formatSessionHeader(currentSessionHash);
			appendFileSync(sessionFile, header + "\n");
		}

		const obsNumber = countObservations(sessionFile) + 1;
		const obs = formatObservation(obsNumber, userPrompt, toolResults, agentResponse);
		appendFileSync(sessionFile, obs + "\n");

		// ── Auto-extraction trigger ──
		// Envia mensagem follow-up pro LLM a cada cruzamento do threshold (50, 100, ...)
		const count = countObservations(sessionFile);
		const { prompt, bucket } = shouldPromptExtraction(count, lastPromptedBucket);
		if (prompt) {
			lastPromptedBucket = bucket;
			try {
				pi.sendUserMessage(
					`[pi-memory] Session reached ${count} observations (threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					{ deliverAs: "followUp" },
				);
			} catch {
				// Fallback: injeta no próximo before_agent_start
				extractionDueCount = count;
			}
		}

		// ── Memory save reminder ──
		// Turno alterou código e passou o cooldown → lembra o LLM de salvar
		// aprendizagem durável diretamente via memory_save (sem esperar extract).
		if (
			shouldRemindSave(
				toolResults.map((t) => t.name),
				obsNumber,
				lastSaveReminderObs,
				SAVE_REMINDER_COOLDOWN,
			)
		) {
			lastSaveReminderObs = obsNumber;
			try {
				pi.sendUserMessage(
					"[pi-memory] This turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
				{ deliverAs: "followUp" },
				);
			} catch {
				saveReminderDue = true;
			}
		}
	});

	// ── Inject extraction prompt at next user turn ────────────────────────
	pi.on("before_agent_start", async (event, ctx) => {
		if (extractionDueCount > 0) {
			const count = extractionDueCount;
			extractionDueCount = 0;
			return {
				message: {
					customType: "pi-memory",
					content:
						`[pi-memory] Session reached ${count} observations ` +
						`(threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					display: true,
				},
			};
		}
		if (saveReminderDue) {
			saveReminderDue = false;
			return {
				message: {
					customType: "pi-memory",
					content:
						"[pi-memory] A recent turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
					display: true,
				},
			};
		}
	});

	// ── Tools ──────────────────────────────────────────────────────────────

	/* ── memory_status (Part 6) ── */
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Returns current observation count and threshold. " +
			"Call periodically; when count nears ~50, run memory_extract.",
		promptSnippet:
			"memory_status: Check observation count (extract at ~50)",
		parameters: StatusSchema,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!projectId || !currentSessionHash) {
				return {
					content: [{ type: "text", text: "Error: no active session" }],
					details: { error: "no_active_session" },
				};
			}

			const status = getObservationStatus(projectId, currentSessionHash);
			const remaining = Math.max(0, status.threshold - status.observation_count);

			const text = [
				`Observations: ${status.observation_count}/${status.threshold}`,
				`Remaining until extraction: ${remaining}`,
				`Session file: ${status.session_file}`,
				remaining === 0
					? "Threshold reached — call memory_extract now."
					: `Continue working. Call memory_status periodically.`,
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: status,
			};
		},
	});

	/* ── memory_save (Part 4) ── */
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Saves or updates a memory. Same context key = same file (entry is appended). " +
			"Use supersedes to mark an old memory as replaced.",
		promptSnippet:
			"memory_save: Save/update a memory (same context = same file)",
		promptGuidelines: [
			MEMORY_LANGUAGE_RULE,
			"After durable learnings — non-obvious bug fix, architectural decision, recurring gotcha, reusable pattern — call memory_save directly instead of waiting for memory_extract.",
			"Reuse existing context keys for related topics (same context = same file).",
			"Use supersedes to replace a memory that new information contradicts.",
			"Only save with confidence >= 0.5.",
		],
		parameters: SaveSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}

			const result = saveMemory(projectId, params);

			const text =
				result.action === "created"
					? `Created memory: ${params.scope}/${params.type}/${params.context}`
					: `Appended to memory: ${params.scope}/${params.type}/${params.context} (entries: ${result.entries})`;

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});

	/* ── memory_search (Part 5) ── */
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Searches memories via ripgrep. query accepts multiple keywords (OR semantics — any term matches). " +
			"Use when you need past context about a topic. " +
			`Max ${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results — then abandon and search the code instead.`,
		promptSnippet:
			"memory_search: Search past memories (multi-term; max 3 empty tries)",
		promptGuidelines: [
			"Before searching the codebase or web for information about a topic, use memory_search FIRST — past learnings, decisions, patterns and gotchas may already be stored in memories.",
			"Use memory_search when you need past context about a topic, pattern, decision, or gotcha.",
			"Pass multiple keywords as an array — OR semantics (e.g. query: ['cache', 'invalidation']). Pack synonyms/alternatives in one call.",
			"Memories are stored in PT-BR — use Portuguese terms in your queries.",
			`After ${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches with no results, stop searching memories and continue searching the code instead.`,
		],
		parameters: SearchSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				if (!params.query || params.query.length === 0) {
					return {
						content: [{ type: "text", text: "Error: query must contain at least one term." }],
						details: { error: "empty_query" },
					};
				}
				if (consecutiveEmptySearches >= MAX_MEMORY_SEARCH_ATTEMPTS) {
					return {
						content: [
							{
								type: "text",
								text:
									`Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results). ` +
									"Stop searching memories and continue searching the code instead.",
							},
						],
						details: { error: "limit_reached", consecutive_empty: consecutiveEmptySearches },
					};
				}

				const results = searchMemories({
					query: buildSearchPattern(params.query),
					scope: params.scope ?? "all",
					type: params.type,
					minConfidence: params.min_confidence,
					limit: params.limit,
				});

				if (results.length === 0) {
					consecutiveEmptySearches++;
					if (consecutiveEmptySearches >= MAX_MEMORY_SEARCH_ATTEMPTS) {
						return {
							content: [
								{
									type: "text",
									text:
										`No memories found. Memory search limit reached (${MAX_MEMORY_SEARCH_ATTEMPTS} consecutive searches without results) — ` +
										"stop searching memories and continue searching the code instead.",
								},
							],
							details: { count: 0, limit_reached: true, consecutive_empty: consecutiveEmptySearches },
						};
					}
					const remaining = MAX_MEMORY_SEARCH_ATTEMPTS - consecutiveEmptySearches;
					return {
						content: [
							{
								type: "text",
								text:
									`No memories found matching your query. Attempts remaining before abandoning memory search: ${remaining}.`,
							},
						],
						details: { count: 0, consecutive_empty: consecutiveEmptySearches },
					};
				}

				// Achou resultado — reset contador de buscas vazias (pode continuar buscando)
				consecutiveEmptySearches = 0;

				// Format results as text for the LLM
				const lines: string[] = [`Found ${results.length} result(s):`, ""];
				for (const r of results) {
					// Show relative path from MEMORIES_ROOT
					const displayPath = r.file.replace(/^.*\/memories\//, "memories/");
					lines.push(`  ${displayPath}`);
					for (const l of r.lines.slice(0, 5)) {
						lines.push(`    ${l}`);
					}
					if (r.lines.length > 5) {
						lines.push(`    ... ${r.lines.length - 5} more matches`);
					}
					lines.push("");
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: results.length, results },
				};
			} catch (e: unknown) {
				const msg = (e as Error).message ?? String(e);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: { error: msg },
				};
			}
		},
	});

	/* ── memory_decay (Part 7) ── */
	pi.registerTool({
		name: "memory_decay",
		label: "Memory Decay",
		description:
			"Reduces confidence of a memory or moves it to .supersedes/. " +
			"Call when a memory is obsolete or contradicted.",
		promptSnippet:
			"memory_decay: Reduce confidence or supersede a memory",
		parameters: DecaySchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}

			const { context, delta, move_to_supersedes, reason } = params;

			const filePath = findMemoryFile(projectId, context);
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
			meta.confidence = newConf;
			meta.updated = new Date().toISOString().slice(0, 10);
			writeFileSync(filePath, formatFrontmatter(meta) + body);

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

	/* ── memory_extract (Part 8) ── */
	pi.registerTool({
		name: "memory_extract",
		label: "Memory Extract",
		description:
			"Processes session observations into organized memories. " +
			"Reads the session file, identifies contexts, and saves memories via memory_save. " +
			"Memories are written in PT-BR.",
		promptSnippet:
			"memory_extract: Process session observations into memories",
		parameters: ExtractSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!projectId || !currentSessionHash) {
				return {
					content: [{ type: "text", text: "Error: no active session" }],
					details: { error: "no_active_session" },
				};
			}

			// 1. Determine session file and read content
			let sessionFile: string;
			if (params.session_file) {
				sessionFile = params.session_file.startsWith("/")
					? params.session_file
					: join(MEMORIES_ROOT, "projects", projectId, "sessions", params.session_file);
			} else {
				sessionFile = getSessionFilePath(projectId, currentSessionHash);
			}

			const sessionContent = readSessionContent(sessionFile);
			if (!sessionContent.trim()) {
				return {
					content: [{ type: "text", text: "Session file is empty or missing." }],
					details: { error: "empty_session", session_file: sessionFile },
				};
			}

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

			const prompt = buildExtractionPrompt(sessionContent);

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

			// 3. Save each memory
			const saved: { context: string; action: string }[] = [];
			for (const mem of memories) {
				const result = saveMemory(projectId, {
					type: mem.type,
					context: mem.context,
					title: mem.title,
					content: mem.content,
					scope: mem.scope,
					confidence: mem.confidence ?? 0.5,
					tags: mem.tags ?? [],
				});
				saved.push({ context: mem.context, action: result.action });
			}

			// 4. Reset session file (mesmo hash, zero observações) — só após sucesso
			resetSessionFile(sessionFile, currentSessionHash);
			lastPromptedBucket = -1; // reinicia ciclo de trigger (próximo trigger às 50)

			const summary = saved
				.map((s) => `- ${s.action}: ${s.context}`)
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Extracted ${saved.length} memory(ies) from ${sessionFile}:\n${summary}\nSession observations reset.`,
					},
				],
				details: {
					count: saved.length,
					saved,
					session_file: sessionFile,
					reset: true,
				},
			};
		},
	});
}
