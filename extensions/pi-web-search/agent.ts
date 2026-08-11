/**
 * Web Search Extension — Research Agent (web_agent)
 *
 * Orchestrates multi-branch web research via web_search and web_fetch.
 * Tracks session state through pi events so the LLM can focus on strategy.
 *
 * Phase 1: Tool registration + state management (no event listeners yet).
 * Phase 2: Event-driven query/fetch tracking.
 * Phase 3: Contextual suggestions.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryRecord {
	toolCallId: string;
	query: string;
	status: "pending" | "done" | "error";
	resultCount?: number;	error?: string;
	discoveredUrls?: string[];
}

export interface FetchRecord {
	toolCallId: string;
	url: string;
	status: "pending" | "done" | "error";
	file?: string;
	size?: number;
	/** conteúdo baixado como binário (PDF, imagem, arquivo, ...) */
	binary?: boolean;
	error?: string;
}

export interface ResearchState {
	goal: string | null;
	queries: Map<string, QueryRecord>;
	fetches: Map<string, FetchRecord>;
}

// ---------------------------------------------------------------------------
// State — 1 active session at a time
// ---------------------------------------------------------------------------

let currentState: ResearchState = {
	goal: null,
	queries: new Map(),
	fetches: new Map(),
};

/** Return true if `goal` differs from the current active goal. */
function isNewGoal(goal: string): boolean {
	return currentState.goal === null || currentState.goal !== goal;
}

/** Reset all state and set a new goal. */
function resetState(goal: string): void {
	currentState = {
		goal,
		queries: new Map(),
		fetches: new Map(),
	};
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function formatInactive(): string {
	return [
		"## 🧠 Research: (inactive)",
		"",
		"Call **web_agent** with a research goal to start a multi-branch search session.",
		"",
		"Example:",
		"```",
		'web_agent({ "goal": "Find best CLI tools for developers 2025" })',
		"```",
	].join("\n");
}

function formatEmpty(goal: string): string {
	return [
		`## 🧠 Research: "${goal}"`,
		"",
		"### Searches (0)",
		"No searches yet.",
		"",
		"### Pages Fetched (0)",
		"No pages fetched yet.",
		"",
		"### Suggestions",
		"- Break down the goal into specific search queries",
		"- Start by calling **web_search** with targeted terms",
		"- Use **web_fetch** after collecting URLs from results",
	].join("\n");
}

/** All unique URLs discovered across all done searches. */
function getDiscoveredUrls(): string[] {
	const seen = new Set<string>();
	for (const q of currentState.queries.values()) {
		if (q.discoveredUrls) {
			for (const url of q.discoveredUrls) {
				seen.add(url);
			}
		}
	}
	return [...seen];
}

/** Set of URLs that have been submitted for fetch (any status). */
function getSubmittedFetchUrls(): Set<string> {
	return new Set([...currentState.fetches.values()].map((f) => f.url));
}

/** URLs discovered but not yet submitted to web_fetch. */
function getNotYetFetched(): string[] {
	const discovered = getDiscoveredUrls();
	const submitted = getSubmittedFetchUrls();
	return discovered.filter((url) => !submitted.has(url));
}

function formatState(): string {
	if (currentState.goal === null) {
		return formatInactive();
	}

	const goal = currentState.goal;
	const queries = [...currentState.queries.values()];
	const fetches = [...currentState.fetches.values()];

	// Counts
	const pendingQ = queries.filter((q) => q.status === "pending").length;
	const doneQ = queries.filter((q) => q.status === "done").length;
	const errorQ = queries.filter((q) => q.status === "error").length;
	const totalQ = queries.length;

	const pendingF = fetches.filter((f) => f.status === "pending").length;
	const doneF = fetches.filter((f) => f.status === "done").length;
	const errorF = fetches.filter((f) => f.status === "error").length;
	const totalF = fetches.length;

	const notYetFetched = getNotYetFetched();

	const lines: string[] = [];

	lines.push(`## 🧠 Research: "${goal}"`);
	lines.push("");

	// ── Searches ─────────────────────────────────────────────────────
	lines.push(`### Searches (${totalQ})`);

	if (totalQ === 0) {
		lines.push("No searches yet.");
	} else {
		for (const q of queries) {
			const icon =
				q.status === "done" ? "✅" : q.status === "error" ? "❌" : "⏳";
			const detail =
				q.status === "done"
					? `${q.resultCount} results`
					: q.status === "error"
						? q.error ?? "error"
						: "pending";
			lines.push(`  ${icon} "${q.query}" → ${detail}`);
		}
	}

	// ── Discovered URLs ──────────────────────────────────────────────
	lines.push("");
	if (notYetFetched.length > 0) {
		lines.push(`### Discovered URLs (${notYetFetched.length} not yet fetched)`);
		for (const url of notYetFetched) {
			lines.push(`  🔗 ${url}`);
		}
		lines.push("");
		lines.push("Pass ALL URLs below to **web_fetch** in a single call:");
		lines.push("```json");
		lines.push(JSON.stringify(notYetFetched, null, 2));
		lines.push("```");
	} else if (totalQ > 0) {
		lines.push("### Discovered URLs");
		const allDiscovered = getDiscoveredUrls();
		if (allDiscovered.length === 0) {
			lines.push("No URLs discovered from searches.");
		} else {
			lines.push(`All ${allDiscovered.length} discovered URLs have been submitted for fetch.`);
		}
	}

	// ── Pages Fetched ────────────────────────────────────────────────
	lines.push("");
	lines.push(`### Pages Fetched (${totalF})`);

	if (totalF === 0) {
		lines.push("No pages fetched yet.");
	} else {
		for (const f of fetches) {
			const icon =
				f.status === "done"
					? f.binary
						? "⬇️"
						: "✅"
					: f.status === "error"
						? "❌"
						: "⏳";
			const detail =
				f.status === "done"
					? `${f.file} (${((f.size ?? 0) / 1024).toFixed(1)} KB)${f.binary ? " — binário" : ""}`
					: f.status === "error"
						? f.error ?? "error"
						: "pending";
			lines.push(`  ${icon} ${f.url}`);
			lines.push(`     → ${detail}`);
		}
	}

	// ── Suggestions ──────────────────────────────────────────────────
	lines.push("");
	lines.push("### Suggestions");

	if (totalQ === 0) {
		lines.push("- Break down the goal into specific search queries");
		lines.push("- Start by calling **web_search** with targeted terms");
		lines.push("- Use **web_fetch** after collecting URLs from results");
	} else {
		if (pendingQ > 0) {
			lines.push(`- Wait for ${pendingQ} pending search(es) to complete`);
		}
		if (pendingF > 0) {
			lines.push(`- Wait for ${pendingF} pending page fetch(es) to complete`);
		}
		if (errorQ > 0) {
			lines.push(`- Retry ${errorQ} failed search(es) with adjusted terms`);
		}
		if (errorF > 0) {
			lines.push(`- ${errorF} page fetch(es) failed — check URLs for typos or access`);
		}
		if (doneQ > 0 && notYetFetched.length > 0) {
			lines.push(`- **web_fetch** ALL ${notYetFetched.length} discovered URL(s) at once using the JSON array above`);
		}
		if (doneQ > 0 && doneF > 0 && notYetFetched.length === 0 && pendingQ === 0 && pendingF === 0) {
			lines.push("- Research complete — summarize findings for the user");
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API — called from index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `web_agent` tool.
 *
 * Call **after** web_search and web_fetch so the event interceptors
 * (Phase 2+) can distinguish our tools from built-in ones.
 */
export function registerWebAgent(pi: ExtensionAPI): void {
	registerTool(pi);
	registerListeners(pi);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_agent",
		label: "Web Research Agent",
		description:
			"Orchestrates multi-branch web research. Call with a research goal to " +
			"start or continue a search session. Omitting the goal returns the " +
			"current session state. Tracks web_search and web_fetch automatically.",

		parameters: Type.Object({
			goal: Type.Optional(
				Type.String({
					description:
						"Research goal. Provide a new goal to start a fresh session; " +
						"omit to query the current session state.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { goal } = params as { goal?: string };

			// No goal — return current state (inactive or ongoing)
			if (goal === undefined || goal === "") {
				return {
					content: [{ type: "text" as const, text: formatState() }],
					details: {
						goal: currentState.goal,
						queries: [...currentState.queries.values()],
						fetches: [...currentState.fetches.values()],
					},
				};
			}

			// New goal — reset session
			if (isNewGoal(goal)) {
				resetState(goal);
			}

			return {
				content: [{ type: "text" as const, text: formatState() }],
				details: {
					goal: currentState.goal,
					queries: [...currentState.queries.values()],
					fetches: [...currentState.fetches.values()],
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Event listeners — auto-track web_search and web_fetch
// ---------------------------------------------------------------------------

function registerListeners(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (currentState.goal === null) return;

		if (event.toolName === "web_search") {
			const query = (event.input as { query: string }).query;
			currentState.queries.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				query,
				status: "pending",
			});
		}

		if (event.toolName === "web_fetch") {
			const urls = (event.input as { urls: string[] }).urls;
			for (const url of urls) {
				currentState.fetches.set(`${event.toolCallId}:${url}`, {
					toolCallId: event.toolCallId,
					url,
					status: "pending",
				});
			}
		}
	});

	pi.on("tool_result", async (event) => {
		if (currentState.goal === null) return;

		if (event.toolName === "web_search") {
			const record = currentState.queries.get(event.toolCallId);
			if (!record) return;

			const details = event.details as {
				results?: Array<{ url: string; title?: string; snippet?: string }>;
				error?: string;
			};

			if (event.isError) {
				record.status = "error";
				record.error = details.error ?? "unknown error";
			} else if (details.error && !details.results?.length) {
				record.status = "error";
				record.error = details.error;
				record.resultCount = 0;
			} else {
				record.status = "done";
				const results = details.results ?? [];
				record.resultCount = results.length;
				record.discoveredUrls = results.map((r) => r.url).filter(Boolean);
			}
		}

		if (event.toolName === "web_fetch") {
			const details = event.details as {
				results?: Array<{
					url: string;
					file?: string;
					size?: number;
					binary?: boolean;
					error?: string;
				}>;
			};

			const results = details.results ?? [];
			for (const r of results) {
				const key = `${event.toolCallId}:${r.url}`;
				const record = currentState.fetches.get(key);
				if (!record) continue;

				if (r.error) {
					record.status = "error";
					record.error = r.error;
				} else {
					record.status = "done";
					record.file = r.file;
					record.size = r.size;
					record.binary = r.binary;
				}
			}
		}
	});
}

// ---------------------------------------------------------------------------
// State helpers (for testing)
// ---------------------------------------------------------------------------

/** @visibleForTesting */
export function __resetState(): void {
	currentState = { goal: null, queries: new Map(), fetches: new Map() };
}

/** @visibleForTesting */
export function __getState(): ResearchState {
	return currentState;
}
