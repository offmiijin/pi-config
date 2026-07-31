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
	countObservations,
	ensureDirectories,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	findMemoryFile,
	formatFrontmatter,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	getObservationStatus,
	getSessionFilePath,
	hashSessionFile,
	identifyProject,
	MEMORIES_ROOT,
	moveToSupersedes,
	OBSERVATION_THRESHOLD,
	parseExtractionResult,
	parseFrontmatter,
	readSessionContent,
	saveMemory,
	searchMemories,
	shouldPromptExtraction,
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

	// ── Session lifecycle ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);
		ensureDirectories(projectId);

		const sessionFile = ctx.sessionManager.getSessionFile();
		currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();

		// Reset auto-extraction trigger state
		lastPromptedBucket = -1;
		extractionDueCount = 0;
	});

	pi.on("session_tree", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);

		// Reset trigger state on branch navigation
		lastPromptedBucket = -1;
		extractionDueCount = 0;
	});

	// ── Append observations at turn_end ────────────────────────────────────
	pi.on("turn_end", async (event, ctx) => {
		if (!projectId || !currentSessionHash) return;

		const assistantMsg = event.message;
		if (!assistantMsg) return;

		const branch = ctx.sessionManager.getBranch();
		let userPrompt = "";
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "user") {
				userPrompt = extractTextContent(entry.message.content);
				break;
			}
		}

		const toolCalls = extractToolCallNames(assistantMsg.content);
		const agentResponse = extractTextContent(assistantMsg.content);

		const sessionFile = getSessionFilePath(projectId, currentSessionHash);
		ensureFileDir(sessionFile);

		if (!existsSync(sessionFile)) {
			const header = formatSessionHeader(currentSessionHash);
			appendFileSync(sessionFile, header + "\n");
		}

		const obsNumber = countObservations(sessionFile) + 1;
		const obs = formatObservation(obsNumber, userPrompt, toolCalls, agentResponse);
		appendFileSync(sessionFile, obs + "\n");

		// ── Auto-extraction trigger ──
		// Sinaliza o LLM (via before_agent_start) a cada cruzamento do threshold
		const count = countObservations(sessionFile);
		const { prompt, bucket } = shouldPromptExtraction(count, lastPromptedBucket);
		if (prompt) {
			lastPromptedBucket = bucket;
			extractionDueCount = count;
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
			"Searches memories via ripgrep. " +
			"Use when you need past context about a topic.",
		promptSnippet:
			"memory_search: Search past memories via ripgrep",
		parameters: SearchSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const results = searchMemories({
					query: params.query,
					scope: params.scope ?? "all",
					type: params.type,
					minConfidence: params.min_confidence,
					limit: params.limit,
				});

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No memories found matching your query." }],
						details: { count: 0 },
					};
				}

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
			"Reads the session file, identifies contexts, and saves memories via memory_save.",
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

			const summary = saved
				.map((s) => `- ${s.action}: ${s.context}`)
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Extracted ${saved.length} memory(ies) from ${sessionFile}:\n${summary}`,
					},
				],
				details: { count: saved.length, saved, session_file: sessionFile },
			};
		},
	});
}
