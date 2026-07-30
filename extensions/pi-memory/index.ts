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
 *   3. [ ] Register 5 tools (scaffold with stubs)
 *   4. [ ] memory_save — persist/update markdown files
 *   5. [ ] memory_search — ripgrep wrapper
 *   6. [ ] memory_status — observation counter
 *   7. [ ] memory_decay — confidence reduction / supersede
 *   8. [ ] memory_extract — process session file via LLM
 *   9. [ ] Skill with usage instructions
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ensureDirectories,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	formatObservation,
	formatSessionHeader,
	generateSessionHash,
	hashSessionFile,
	identifyProject,
} from "./utils.ts";
import { countObservations, getSessionFilePath } from "./utils.ts";

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Runtime state (per session, reset on reload)
	let projectId = "";
	let currentSessionHash = "";

	// ── Session lifecycle ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		projectId = identifyProject(ctx.cwd);
		ensureDirectories(projectId);

		// Generate a session hash for the session file
		const sessionFile = ctx.sessionManager.getSessionFile();
		currentSessionHash = sessionFile ? hashSessionFile(sessionFile) : generateSessionHash();
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Re-read project on tree navigation (same session, different branch)
		projectId = identifyProject(ctx.cwd);
	});

	// ── Append observations at turn_end ────────────────────────────────────
	pi.on("turn_end", async (event, ctx) => {
		if (!projectId || !currentSessionHash) return;

		const assistantMsg = event.message;
		if (!assistantMsg) return;

		// 1. Find the last user prompt from the session branch
		const branch = ctx.sessionManager.getBranch();
		let userPrompt = "";
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "user") {
				userPrompt = extractTextContent(entry.message.content);
				break;
			}
		}

		// 2. Extract tool calls and assistant response from the assistant message
		const toolCalls = extractToolCallNames(assistantMsg.content);
		const agentResponse = extractTextContent(assistantMsg.content);

		// 3. Build session file path
		const sessionFile = getSessionFilePath(projectId, currentSessionHash);

		// 4. Ensure directory exists
		ensureFileDir(sessionFile);

		// 5. If file is new, write the session header
		if (!existsSync(sessionFile)) {
			const header = formatSessionHeader(currentSessionHash);
			appendFileSync(sessionFile, header + "\n");
		}

		// 6. Count existing observations to determine the next number
		const obsNumber = countObservations(sessionFile) + 1;

		// 7. Format and append the observation
		const obs = formatObservation(obsNumber, userPrompt, toolCalls, agentResponse);
		appendFileSync(sessionFile, obs + "\n");
	});

	// ── Tools (stubs — registered in subsequent parts) ────────────────────
}
