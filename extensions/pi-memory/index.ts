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
import { join, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyDecay,
	archiveSessionFile,
	buildExtractionPrompt,
	buildSearchPattern,
	buildTurnFingerprint,
	countObservations,
	createTurnDedupState,
	ensureDirectories,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	extractToolCalls,
	findMemoryFile,
	type ToolObservation,
	formatFrontmatter,
	formatMemoryIndexText,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	getObservationStatus,
	getSessionFilePath,
	hashSessionFile,
	identifyProject,
	listMemoryContexts,
	listMemoryIndex,
	MAX_MEMORY_SEARCH_ATTEMPTS,
	MEMORIES_ROOT,
	MEMORY_LANGUAGE_RULE,
	moveToSupersedes,
	nextTurnDedup,
	OBSERVATION_THRESHOLD,
	parseExtractionResult,
	parseFrontmatter,
	readSessionContent,
	removeProcessedObservations,
	resetSessionFile,
	saveMemory,
	SAVE_REMINDER_COOLDOWN,
	searchMemories,
	selectObservationsBatch,
	shouldPromptExtraction,
	shouldRemindSave,
	splitObservations,
	summarizeExistingMemories,
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
	// Flag: reminder enviado neste turno de usuário (máx 1x por turno —
	// turn_end pode disparar várias vezes dentro do mesmo turno com edits)
	let saveReminderSent = false;
	// Session memory index — injetado no SYSTEM PROMPT (cache por sessão,
	// invalidado em memory_save/memory_extract/memory_decay)
	let cachedIndexText: string | null = null;
	// Dedup de turnos (harness pode disparar turn_end 2x p/ o mesmo turno)
	let turnDedupState = createTurnDedupState();
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
		saveReminderSent = false;
		// Reset session memory index cache
		cachedIndexText = null;
		// Reset turn dedup state
		turnDedupState = createTurnDedupState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		const nextProjectId = identifyProject(ctx.cwd);
		if (nextProjectId === projectId) {
			// Mesmo projeto: NÃO resetar trigger state. Resetar lastPromptedBucket
			// aqui, com um followUp de extração ainda pendente (nextTurn), faria
			// o trigger re-disparar o mesmo bucket → mensagem duplicada no
			// próximo prompt de usuário.
			return;
		}
		projectId = nextProjectId;

		// Reset trigger state on project change
		lastPromptedBucket = -1;
		extractionDueCount = 0;
		// Reset memory search policy state
		consecutiveEmptySearches = 0;
		// Reset save reminder state
		saveReminderDue = false;
		lastSaveReminderObs = 0;
		saveReminderSent = false;
		// Reset session memory index cache
		cachedIndexText = null;
		// Reset turn dedup state
		turnDedupState = createTurnDedupState();
	});

	// ── Append observations at turn_end ────────────────────────────────────
	pi.on("turn_end", async (event, ctx) => {
		if (!projectId || !currentSessionHash) return;

		const assistantMsg = event.message;
		if (!assistantMsg) return;

		const agentResponse = extractTextContent(assistantMsg.content);

		// ── Dedup de turno ──
		// O harness pode disparar turn_end mais de uma vez para o MESMO turno
		// (observado em sessões com followUps: obs duplicadas, count inflado,
		// reminders/triggers re-disparados). Dedup por event.turnIndex (índice
		// único por turno); fallback por fingerprint de conteúdo quando o
		// turnIndex não está disponível.
		const fingerprint = buildTurnFingerprint(assistantMsg.content);
		const turnIndex = (event as { turnIndex?: number }).turnIndex;
		const { skip, state: nextState } = nextTurnDedup(turnIndex, fingerprint, turnDedupState);
		turnDedupState = nextState;
		if (skip) return;

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
		// Envia mensagem pro LLM a cada cruzamento do threshold (50, 100, ...).
		// Entrega via "nextTurn" (não followUp): sem atraso intra-turno, sem
		// ciclo extra. lastPromptedBucket (monotônico) já garante 1x/threshold;
		// não é resetado em before_agent_start nem em session_tree no mesmo
		// projeto (evita re-disparo do mesmo bucket com mensagem pendente).
		const count = countObservations(sessionFile);
		const { prompt, bucket } = shouldPromptExtraction(count, lastPromptedBucket);
		if (prompt) {
			lastPromptedBucket = bucket;
			try {
				pi.sendUserMessage(
					`[pi-memory] Session reached ${count} observations (threshold ${OBSERVATION_THRESHOLD}). ` +
						"Call memory_extract to process observations into memories.",
					{ deliverAs: "nextTurn" },
				);
			} catch {
				// Fallback: injeta no próximo before_agent_start
				extractionDueCount = count;
			}
		}

		// ── Memory save reminder ──
		// Turno alterou código e passou o cooldown → lembra o LLM de salvar
		// aprendizagem durável diretamente via memory_save (sem esperar extract).
		// Máx 1x por turno de USUÁRIO: guard saveReminderSent é resetado em
		// agent_settled (fim real do prompt) — NÃO em before_agent_start, que
		// dispara também para ciclos gerados pela própria extensão e resetava o
		// guard no meio do turno (reminders duplicados).
		// Entrega via "nextTurn": não interrompe nem gera ciclo extra — a
		// mensagem chega no próximo prompt do usuário, sem atraso dentro do
		// turno nem re-disparo pelo próprio followUp.
		if (
			!saveReminderSent &&
			shouldRemindSave(
				toolResults.map((t) => t.name),
				obsNumber,
				lastSaveReminderObs,
				SAVE_REMINDER_COOLDOWN,
			)
		) {
			saveReminderSent = true;
			lastSaveReminderObs = obsNumber;
			try {
				pi.sendUserMessage(
					"[pi-memory] This turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
				{ deliverAs: "nextTurn" },
				);
			} catch {
				saveReminderDue = true;
			}
		}
	});

	// ── Inject extraction prompt + memory index at next user turn ───────────
	pi.on("before_agent_start", async (event, ctx) => {
		// NOTA: NÃO resetar saveReminderSent aqui. before_agent_start dispara
		// também para ciclos gerados pela própria extensão (sendUserMessage), o
		// que resetava o guard no meio do turno e permitia reminders duplicados.
		// Reset acontece em agent_settled (fim real do prompt de usuário).

		// Índice de memórias no SYSTEM PROMPT (reconstruído por turno — não
		// polui o histórico de mensagens como a mensagem customType fazia).
		// Cache por sessão, invalidado nas escritas (memory_save/extract/decay).
		const withIndex = (prompt: string): string => {
			if (!projectId) return prompt;
			if (cachedIndexText === null) {
				cachedIndexText = formatMemoryIndexText(listMemoryIndex(projectId));
			}
			return `${prompt}\n\n${cachedIndexText}`;
		};

		if (extractionDueCount > 0) {
			const count = extractionDueCount;
			extractionDueCount = 0;
			return {
				systemPrompt: withIndex(event.systemPrompt),
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
				systemPrompt: withIndex(event.systemPrompt),
				message: {
					customType: "pi-memory",
					content:
						"[pi-memory] A recent turn changed code. If it involved a durable learning (bug cause, decision, gotcha, pattern), call memory_save now. Otherwise ignore.",
					display: true,
				},
			};
		}

		return { systemPrompt: withIndex(event.systemPrompt) };
	});

	// ── Fim do prompt de usuário → libera novo reminder no próximo turno ─────
	pi.on("agent_settled", async (_event, _ctx) => {
		// agent_settled = fim real do prompt (após retries/compaction/followUps).
		// Reset do guard aqui (e não em before_agent_start) garante no máximo
		// 1 reminder por turno de USUÁRIO, mesmo com turnos longos de tools.
		saveReminderSent = false;
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
			"Saves or updates a memory. Same context key = same file. " +
			"mode 'append' (default) adds a dated entry; mode 'consolidate' rewrites the memory, archiving the old version to .supersedes/ (merge-in-place). " +
			"Provide 'summary' (1-2 sentences, PT-BR) describing the CURRENT state — it is persisted and updated on every append/consolidate. " +
			"Use supersedes to mark a memory under a DIFFERENT context key as replaced.",
		promptSnippet:
			"memory_save: Save/update a memory (same context = same file)",
		promptGuidelines: [
			MEMORY_LANGUAGE_RULE,
			"Before saving, call memory_search on the topic — reuse the existing context key if a memory already exists, or use supersedes if the new information contradicts it.",
			"After durable learnings — non-obvious bug fix, architectural decision, recurring gotcha, reusable pattern — call memory_save directly instead of waiting for memory_extract.",
			"Use supersedes to replace a memory that new information contradicts.",
			"Use mode='consolidate' when the new content updates/contradicts the existing memory with the SAME context key (old version is archived to .supersedes/). Use supersedes to replace a memory under a DIFFERENT context key.",
			"Always provide 'summary' (1-2 sentences in PT-BR) describing the CURRENT state of the knowledge — it replaces the previous summary and is used by memory_extract for dedup.",
			"Only save with confidence >= 0.5.",
		],
		parameters: SaveSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Escrita altera o índice de memórias → invalida cache do system prompt
			cachedIndexText = null;
			if (!projectId) {
				return {
					content: [{ type: "text", text: "Error: no active project" }],
					details: { error: "no_active_project" },
				};
			}

			const result = saveMemory(projectId, params);

			if (result.action === "error") {
				return {
					content: [{ type: "text", text: `Error saving memory: ${result.error}` }],
					details: result,
				};
			}

			const text =
				result.action === "created"
					? `Created memory: ${params.scope}/${params.type}/${params.context}`
					: result.action === "consolidated"
						? `Consolidated memory (old version archived to .supersedes/): ${params.scope}/${params.type}/${params.context}`
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
			"scope: 'global' (only global), 'project' (only current project), 'all' (default: current project + global). " +
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
				if (params.scope !== "global" && !projectId) {
					return {
						content: [
							{ type: "text", text: "Error: no active project for scope=project/all" },
						],
						details: { error: "no_active_project" },
					};
				}

				const results = searchMemories({
					query: buildSearchPattern(params.query),
					scope: params.scope ?? "all",
					type: params.type,
					minConfidence: params.min_confidence,
					limit: params.limit,
					projectId,
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
			// Escrita altera o índice de memórias → invalida cache do system prompt
			cachedIndexText = null;
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
			"Processes session observations into organized memories (incremental — one batch per call). " +
			"Reads the session file, identifies contexts, and saves memories via memory_save. " +
			"If observations remain after the call, call memory_extract again to drain the backlog. " +
			"Memories are written in PT-BR.",
		promptSnippet:
			"memory_extract: Process session observations into memories",
		parameters: ExtractSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Escrita altera o índice de memórias → invalida cache do system prompt
			cachedIndexText = null;
			if (!projectId || !currentSessionHash) {
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
				const sessionsDir = join(MEMORIES_ROOT, "projects", projectId, "sessions");
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
				sessionFile = getSessionFilePath(projectId, currentSessionHash);
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

			const existingMemories = summarizeExistingMemories(projectId);
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
					const result = saveMemory(projectId, {
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
				lastPromptedBucket = -1;
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
			resetSessionFile(sessionFile, currentSessionHash);
			lastPromptedBucket = -1; // reinicia ciclo de trigger (próximo trigger às 50)

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
