/**
 * Tests for agent.ts
 *
 * Phase 1: Tool registration, goal management, state transitions, output formatting
 * Phase 2: Event-driven query/fetch tracking via tool_call and tool_result
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { __resetState, __getState } from "../agent";

// ---------------------------------------------------------------------------
// Fake ExtensionAPI
// ---------------------------------------------------------------------------
interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}>;
}

interface FakeAPI {
	registerTool: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	getTools: () => RegisteredTool[];
	getTool: (name: string) => RegisteredTool | undefined;
	emit: (event: string, arg: unknown) => Promise<void>;
}

function createFakeAPI(): FakeAPI {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, Array<(arg: unknown) => Promise<void>>>();

	return {
		registerTool: vi.fn((def: RegisteredTool) => {
			tools.push(def);
		}),
		on: vi.fn((event: string, handler: (arg: unknown) => Promise<void>) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		}),
		getTools: () => tools,
		getTool: (name: string) => tools.find((t) => t.name === name),
		emit: async (event: string, arg: unknown) => {
			const hs = handlers.get(event) ?? [];
			for (const h of hs) {
				await h(arg);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load agent module fresh */
async function loadAgent() {
	return await import("../agent");
}

// ---------------------------------------------------------------------------
// Phase 1 — State management
// ---------------------------------------------------------------------------
describe("state management", () => {
	beforeEach(() => {
		__resetState();
	});

	it("starts with inactive state", () => {
		const state = __getState();
		expect(state.goal).toBeNull();
		expect(state.queries.size).toBe(0);
		expect(state.fetches.size).toBe(0);
	});

	it("new goal sets the goal", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		const result = await tool.execute("id1", { goal: "test goal" }, undefined);

		expect(result.details.goal).toBe("test goal");
		expect(__getState().goal).toBe("test goal");
	});

	it("same goal preserves state", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);
		const tool = api.getTool("web_agent")!;

		await tool.execute("id1", { goal: "same goal" }, undefined);
		expect(__getState().goal).toBe("same goal");

		await tool.execute("id2", { goal: "same goal" }, undefined);
		expect(__getState().goal).toBe("same goal");
	});

	it("different goal resets state", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);
		const tool = api.getTool("web_agent")!;

		await tool.execute("id1", { goal: "first goal" }, undefined);
		expect(__getState().goal).toBe("first goal");

		await tool.execute("id2", { goal: "second goal" }, undefined);
		expect(__getState().goal).toBe("second goal");
	});
});

// ---------------------------------------------------------------------------
// Phase 1 — Output formatting
// ---------------------------------------------------------------------------
describe("output formatting", () => {
	beforeEach(() => {
		__resetState();
	});

	it("inactive when no goal provided", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);
		const tool = api.getTool("web_agent")!;

		const result = await tool.execute("id1", {}, undefined);

		expect(result.content[0].text).toContain("Research: (inactive)");
		expect(result.details.goal).toBeNull();
	});

	it("empty state when goal provided", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);
		const tool = api.getTool("web_agent")!;

		const result = await tool.execute("id1", { goal: "my research" }, undefined);

		expect(result.content[0].text).toContain('Research: "my research"');
		expect(result.content[0].text).toContain("Searches (0)");
		expect(result.content[0].text).toContain("Pages Fetched (0)");
		expect(result.content[0].text).toContain("Suggestions");
	});

	it("empty string treated as no goal", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);
		const tool = api.getTool("web_agent")!;

		await tool.execute("id1", { goal: "real goal" }, undefined);

		const result = await tool.execute("id2", { goal: "" }, undefined);
		expect(result.content[0].text).toContain('Research: "real goal"');
		expect(__getState().goal).toBe("real goal");
	});

	it("details include goal, queries, and fetches arrays", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);
		const tool = api.getTool("web_agent")!;

		const result = await tool.execute("id1", { goal: "test" }, undefined);

		expect(result.details).toHaveProperty("goal", "test");
		expect(result.details).toHaveProperty("queries");
		expect(Array.isArray(result.details.queries)).toBe(true);
		expect(result.details).toHaveProperty("fetches");
		expect(Array.isArray(result.details.fetches)).toBe(true);
	});

	it("has correct metadata", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		expect(api.registerTool).toHaveBeenCalledTimes(1);
		const call = api.registerTool.mock.calls[0][0];
		expect(call.name).toBe("web_agent");
		expect(call.label).toBe("Web Research Agent");
		expect(call.parameters).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Phase 2 — Event listeners: tool_call tracking
// ---------------------------------------------------------------------------
describe("tool_call tracking", () => {
	beforeEach(() => {
		__resetState();
	});

	it("registers web_search query as pending", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		// Start a session
		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		// Simulate tool_call for web_search
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "best CLI tools" },
		});

		const state = __getState();
		expect(state.queries.size).toBe(1);

		const record = state.queries.get("call-1")!;
		expect(record.toolCallId).toBe("call-1");
		expect(record.query).toBe("best CLI tools");
		expect(record.status).toBe("pending");
	});

	it("registers multiple web_search queries", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "query one" },
		});
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-2",
			input: { query: "query two" },
		});

		expect(__getState().queries.size).toBe(2);
	});

	it("registers web_fetch URLs as pending", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com", "https://b.com"] },
		});

		const state = __getState();
		expect(state.fetches.size).toBe(2);

		const r1 = state.fetches.get("fetch-1:https://a.com")!;
		expect(r1.url).toBe("https://a.com");
		expect(r1.status).toBe("pending");

		const r2 = state.fetches.get("fetch-1:https://b.com")!;
		expect(r2.url).toBe("https://b.com");
		expect(r2.status).toBe("pending");
	});

	it("ignores tool_call when no active goal", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		// No session started — emit events
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "ignored query" },
		});

		expect(__getState().queries.size).toBe(0);
	});

	it("ignores tool_call for other tools", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "rm -rf /" },
		});

		expect(__getState().queries.size).toBe(0);
		expect(__getState().fetches.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Phase 2 — Event listeners: tool_result tracking
// ---------------------------------------------------------------------------
describe("tool_result tracking", () => {
	beforeEach(() => {
		__resetState();
	});

	it("updates web_search query to done with result count", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		// Register query
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "best CLI tools" },
		});

		// Complete it
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				query: "best CLI tools",
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
					{ title: "B", url: "https://b.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		const record = __getState().queries.get("call-1")!;
		expect(record.status).toBe("done");
		expect(record.resultCount).toBe(2);
	});

	it("updates web_search to error when isError is true", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "broken query" },
		});

		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: { error: "HTTP 403" },
			isError: true,
		});

		const record = __getState().queries.get("call-1")!;
		expect(record.status).toBe("error");
		expect(record.error).toBe("HTTP 403");
	});

	it("updates web_search to error when details has error and no results", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "empty query" },
		});

		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: { error: "no results found", results: [] },
			isError: false,
		});

		const record = __getState().queries.get("call-1")!;
		expect(record.status).toBe("error");
		expect(record.error).toBe("no results found");
		expect(record.resultCount).toBe(0);
	});

	it("updates web_fetch URLs to done", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com", "https://b.com"] },
		});

		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{ url: "https://a.com", file: "a.md", size: 1024, status: 200 },
					{
						url: "https://b.com",
						file: "b.pdf",
						size: 2048,
						status: 200,
						binary: true,
					},
				],
			},
			isError: false,
		});

		const r1 = __getState().fetches.get("fetch-1:https://a.com")!;
		expect(r1.status).toBe("done");
		expect(r1.file).toBe("a.md");
		expect(r1.size).toBe(1024);
		expect(r1.binary).toBeUndefined();

		const r2 = __getState().fetches.get("fetch-1:https://b.com")!;
		expect(r2.status).toBe("done");
		expect(r2.file).toBe("b.pdf");
		expect(r2.size).toBe(2048);
		expect(r2.binary).toBe(true);
	});

	it("updates web_fetch URLs to error", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://broken.com"] },
		});

		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{ url: "https://broken.com", error: "ENOTFOUND" },
				],
			},
			isError: false,
		});

		const record = __getState().fetches.get("fetch-1:https://broken.com")!;
		expect(record.status).toBe("error");
		expect(record.error).toBe("ENOTFOUND");
	});

	it("ignores tool_result when no active goal", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: { results: [] },
			isError: false,
		});

		// Should not crash, state unchanged
		expect(__getState().queries.size).toBe(0);
	});

	it("ignores tool_result for unknown toolCallId", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		// Result without prior tool_call — no record exists
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "unknown-call",
			details: { results: [{ title: "A", url: "https://a.com", snippet: "desc" }] },
			isError: false,
		});

		// Should not crash, no record created
		expect(__getState().queries.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Phase 2 — Integration: state queried via web_agent after events
// ---------------------------------------------------------------------------
describe("state query after events", () => {
	beforeEach(() => {
		__resetState();
	});

	it("web_agent output reflects tracked searches", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;

		// Start session
		await tool.execute("id0", { goal: "research" }, undefined);

		// Simulate search
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "best CLI tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "Tool A", url: "https://a.com", snippet: "Great tool" },
				],
			},
			isError: false,
		});

		// Query state via web_agent
		const result = await tool.execute("id1", {}, undefined);

		const text = result.content[0].text;
		expect(text).toContain('Research: "research"');
		expect(text).toContain("Searches (1)");
		expect(text).toContain('"best CLI tools"');
		expect(text).toContain("1 results");
	});

	it("web_agent output reflects tracked fetches", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;

		await tool.execute("id0", { goal: "research" }, undefined);

		// Search + fetch
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "Tool A", url: "https://a.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com"] },
		});
		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{ url: "https://a.com", file: "https_a_com.md", size: 5120, status: 200 },
				],
			},
			isError: false,
		});

		const result = await tool.execute("id2", {}, undefined);

		const text = result.content[0].text;
		expect(text).toContain("Pages Fetched (1)");
		expect(text).toContain("https_a_com.md");
	});

	it("renders binary downloads distinctly", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://example.com/doc.pdf"] },
		});
		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{
						url: "https://example.com/doc.pdf",
						file: "https_example_com_doc_pdf.pdf",
						size: 5120,
						status: 200,
						binary: true,
						textFile: "https_example_com_doc_pdf.txt",
					},
				],
			},
			isError: false,
		});

		const result = await tool.execute("id2", {}, undefined);

		const text = result.content[0].text;
		expect(text).toContain("⬇️");
		expect(text).toContain("https_example_com_doc_pdf.pdf");
		expect(text).toContain("binário");
		expect(text).toContain("texto: https_example_com_doc_pdf.txt");
	});
});

// ---------------------------------------------------------------------------
// Phase 3 — discoveredUrls and contextual suggestions
// ---------------------------------------------------------------------------
describe("discovered URLs tracking", () => {
	beforeEach(() => {
		__resetState();
	});

	it("stores discoveredUrls from web_search results", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
					{ title: "B", url: "https://b.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		const record = __getState().queries.get("call-1")!;
		expect(record.discoveredUrls).toEqual([
			"https://a.com",
			"https://b.com",
		]);
	});

	it("collects unique discovered URLs across multiple queries", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		// Two searches that discover some of the same URLs
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-2",
			input: { query: "more tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-2",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
					{ title: "C", url: "https://c.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		// Query state and check discovered URLs section
		const result = await tool.execute("id3", {}, undefined);
		const text = result.content[0].text;

		// Both URLs discovered but none submitted for fetch yet
		expect(text).toContain("Discovered URLs (2 not yet fetched)");
		expect(text).toContain("https://a.com");
		expect(text).toContain("https://c.com");
	});
});

// ---------------------------------------------------------------------------
// Phase 3 — Suggestions
// ---------------------------------------------------------------------------
describe("suggestions", () => {
	beforeEach(() => {
		__resetState();
	});

	it("suggests web_fetch for discovered URLs not yet fetched", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
					{ title: "B", url: "https://b.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		const result = await tool.execute("id1", {}, undefined);
		const text = result.content[0].text;

		expect(text).toContain("- **web_fetch** ALL 2 discovered URL(s) at once using the JSON array above");
	});

	it("suggests research complete when all searches and fetches are done", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		// Search
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		// Fetch the discovered URL
		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com"] },
		});
		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{ url: "https://a.com", file: "a.md", size: 512, status: 200 },
				],
			},
			isError: false,
		});

		const result = await tool.execute("id2", {}, undefined);
		const text = result.content[0].text;

		expect(text).toContain("- Research complete — summarize findings for the user");
	});

	it("suggests waiting for pending fetches", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		// Search
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		// Fetch started but not completed
		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com"] },
		});

		const result = await tool.execute("id1", {}, undefined);
		const text = result.content[0].text;

		expect(text).toContain("- Wait for 1 pending page fetch(es) to complete");
	});

	it("suggests checking URLs when all fetches fail", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "A", url: "https://a.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com"] },
		});
		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{ url: "https://a.com", error: "HTTP 404" },
				],
			},
			isError: false,
		});

		const result = await tool.execute("id1", {}, undefined);
		const text = result.content[0].text;

		expect(text).toContain("- 1 page fetch(es) failed — check URLs for typos or access");
	});

	it("suggests retrying failed searches", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;
		await tool.execute("id0", { goal: "research" }, undefined);

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "broken query" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: { error: "HTTP 403" },
			isError: true,
		});

		const result = await tool.execute("id1", {}, undefined);
		const text = result.content[0].text;

		expect(text).toContain("- Retry 1 failed search(es) with adjusted terms");
	});
});

// ---------------------------------------------------------------------------
// Phase 3 — Integration: complete research flow
// ---------------------------------------------------------------------------
describe("complete research flow", () => {
	beforeEach(() => {
		__resetState();
	});

	it("shows full state after search + fetch cycle", async () => {
		const { registerWebAgent } = await loadAgent();
		const api = createFakeAPI();
		registerWebAgent(api);

		const tool = api.getTool("web_agent")!;

		// 1. Start session
		await tool.execute("id0", { goal: "Find CLI tools" }, undefined);

		// 2. Two searches
		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-1",
			input: { query: "CLI tools" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-1",
			details: {
				results: [
					{ title: "Tool A", url: "https://a.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		await api.emit("tool_call", {
			toolName: "web_search",
			toolCallId: "call-2",
			input: { query: "Unix replacements" },
		});
		await api.emit("tool_result", {
			toolName: "web_search",
			toolCallId: "call-2",
			details: {
				results: [
					{ title: "Tool B", url: "https://b.com", snippet: "desc" },
					{ title: "Tool C", url: "https://c.com", snippet: "desc" },
				],
			},
			isError: false,
		});

		// 3. Fetch two of the discovered URLs
		await api.emit("tool_call", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			input: { urls: ["https://a.com", "https://b.com"] },
		});
		await api.emit("tool_result", {
			toolName: "web_fetch",
			toolCallId: "fetch-1",
			details: {
				results: [
					{ url: "https://a.com", file: "a.md", size: 1024, status: 200 },
					{ url: "https://b.com", file: "b.md", size: 2048, status: 200 },
				],
			},
			isError: false,
		});

		// 4. Query state
		const result = await tool.execute("id3", {}, undefined);
		const text = result.content[0].text;

		// Header
		expect(text).toContain('Research: "Find CLI tools"');

		// Searches
		expect(text).toContain("Searches (2)");
		expect(text).toContain('"CLI tools"');
		expect(text).toContain('"Unix replacements"');

		// Discovered URLs — c.com not yet fetched
		expect(text).toContain("Discovered URLs (1 not yet fetched)");
		expect(text).toContain("https://c.com");

		// Pages Fetched
		expect(text).toContain("Pages Fetched (2)");
		expect(text).toContain("a.md");
		expect(text).toContain("b.md");

		// Suggestions
		expect(text).toContain("- **web_fetch** ALL 1 discovered URL(s) at once using the JSON array above");

		// Details
		expect(result.details.goal).toBe("Find CLI tools");
	});
});
