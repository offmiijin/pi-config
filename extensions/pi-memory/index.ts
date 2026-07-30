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
 *   2. [ ] Append observations at turn_end
 *   3. [ ] Register 5 tools (scaffold with stubs)
 *   4. [ ] memory_save — persist/update markdown files
 *   5. [ ] memory_search — ripgrep wrapper
 *   6. [ ] memory_status — observation counter
 *   7. [ ] memory_decay — confidence reduction / supersede
 *   8. [ ] memory_extract — process session file via LLM
 *   9. [ ] Skill with usage instructions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ensureDirectories,
	generateSessionHash,
	hashSessionFile,
	identifyProject,
} from "./utils.ts";

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

	// ── Tools (stubs — registered in subsequent parts) ────────────────────
}
