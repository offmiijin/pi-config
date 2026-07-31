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
 *   4. [ ] memory_save — persist/update markdown files
 *   5. [ ] memory_search — ripgrep wrapper
 *   6. [ ] memory_status — observation counter
 *   7. [ ] memory_decay — confidence reduction / supersede
 *   8. [ ] memory_extract — process session file via LLM
 *   9. [ ] Skill with usage instructions
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	countObservations,
	ensureDirectories,
	applyDecay,
	ensureFileDir,
	extractEntryConfidences,
	extractTextContent,
	extractToolCallNames,
	findMemoryFile,
	formatFrontmatter,
	formatMemoryEntry,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	getMemoryFilePath,
	getObservationStatus,
	getSessionFilePath,
	hashSessionFile,
	identifyProject,
	moveToSupersedes,
	parseFrontmatter,
	recalcOverallConfidence,
	searchMemories,
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

	// ── Session lifecycle ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);
		ensureDirectories(projectId);

		const sessionFile = ctx.sessionManager.getSessionFile();
		currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();
	});

	pi.on("session_tree", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);
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

			const {
				type,
				context,
				title,
				content,
				scope,
				tags = [],
				confidence = 0.5,
				supersedes,
			} = params;

			const today = new Date().toISOString().slice(0, 10);

			// 1. Handle supersede: move old memory to .supersedes/
			if (supersedes) {
				const oldPath = getMemoryFilePath(projectId, type, supersedes, scope);
				if (existsSync(oldPath)) {
					moveToSupersedes(oldPath, { superseded_by: context });
				} // if not found, it's already gone — proceed
			}

			// 2. Determine file path
			const filePath = getMemoryFilePath(projectId, type, context, scope);
			ensureFileDir(filePath);

			// 3. Build entry
			const entry = formatMemoryEntry(today, title, content, confidence);

			if (!existsSync(filePath)) {
				// ── Create new file ──
				const meta: Record<string, unknown> = {
					context,
					type,
					created: today,
					updated: today,
					confidence,
					entries: 1,
				};
				if (tags.length > 0) meta.tags = tags;

				const frontmatter = formatFrontmatter(meta);
				writeFileSync(filePath, frontmatter + entry + "\n");

				return {
					content: [{ type: "text", text: `Created memory: ${scope}/${type}/${context}` }],
					details: { action: "created", file: filePath },
				};
			} else {
				// ── Append to existing file ──
				const existing = readFileSync(filePath, "utf-8");
				const { meta, body } = parseFrontmatter(existing);

				// Recalculate confidence
				const existingConfidences = extractEntryConfidences(body);
				const newOverall = recalcOverallConfidence(existingConfidences, confidence);

				// Update frontmatter
				meta.updated = today;
				meta.confidence = newOverall;
				meta.entries = ((meta.entries as number) || 0) + 1;

				// Merge tags
				if (tags.length > 0) {
					const existingTags = (meta.tags as string[]) || [];
					meta.tags = [...new Set([...existingTags, ...tags])];
				}

				const frontmatter = formatFrontmatter(meta);
				writeFileSync(filePath, frontmatter + body + entry + "\n");

				return {
					content: [
						{
							type: "text",
							text: `Appended to memory: ${scope}/${type}/${context} (entries: ${meta.entries})`,
						},
					],
					details: { action: "appended", file: filePath, entries: meta.entries },
				};
			}
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

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [
					{
						type: "text",
						text: "memory_extract not yet implemented",
					},
				],
				details: { implemented: false },
			};
		},
	});
}
