/**
 * pi-memory — Tests: session.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	MEMORIES_ROOT,
	OBSERVATION_THRESHOLD
} from "../constants.ts";

import {
	archiveSessionFile,
	buildTurnFingerprint,
	countObservations,
	createTurnDedupState,
	ensureFileDir,
	estimateTokens,
	extractTextContent,
	extractToolCallNames,
	extractToolCalls,
	extractToolResultText,
	formatDateTime,
	formatObservation,
	formatSessionHeader,
	formatTimestamp,
	generateSessionHash,
	getObservationStatus,
	getSessionFilePath,
	hashSessionFile,
	nextTurnDedup,
	resetSessionFile,
	shouldPromptExtraction,
	shouldRemindSave,
	truncateToTokens
} from "../session.ts";

describe("session hash functions", () => {
	it("hashSessionFile returns 12-char hex string", () => {
		const hash = hashSessionFile("/path/to/session.jsonl");
		expect(hash).toMatch(/^[a-f0-9]{12}$/);
	});

	it("hashSessionFile is deterministic", () => {
		const a = hashSessionFile("same-file.jsonl");
		const b = hashSessionFile("same-file.jsonl");
		expect(a).toBe(b);
	});

	it("hashSessionFile differs for different inputs", () => {
		const a = hashSessionFile("session-one");
		const b = hashSessionFile("session-two");
		expect(a).not.toBe(b);
	});

	it("generateSessionHash returns 12-char hex string", () => {
		const hash = generateSessionHash();
		expect(hash).toMatch(/^[a-f0-9]{12}$/);
	});

	it("generateSessionHash produces unique values", () => {
		const a = generateSessionHash();
		const b = generateSessionHash();
		expect(a).not.toBe(b);
	});
});

// ── Session file path ──────────────────────────────────────────────────────

describe("getSessionFilePath", () => {
	it("uses today's date by default", () => {
		const today = new Date().toISOString().slice(0, 10);
		const path = getSessionFilePath("proj", "abc123");
		expect(path).toContain(today);
	});

	it("includes project, date, and session hash in path", () => {
		const path = getSessionFilePath("my_project", "abc123def456", "2025-06-15");
		expect(path).toContain("my_project");
		expect(path).toContain("2025-06-15");
		expect(path).toContain("abc123def456.md");
		expect(path).toContain("sessions");
	});

	it("accepts custom date", () => {
		const path = getSessionFilePath("p", "h", "2024-01-01");
		expect(path).toContain("2024-01-01");
	});

	it("returns path under MEMORIES_ROOT", () => {
		const path = getSessionFilePath("p", "h");
		expect(path.startsWith(MEMORIES_ROOT)).toBeTrue();
	});

	it("ends with .md extension", () => {
		const path = getSessionFilePath("p", "h");
		expect(path.endsWith(".md")).toBeTrue();
	});
});

// ── extractTextContent ─────────────────────────────────────────────────────

describe("extractTextContent", () => {
	it("returns empty string for null/undefined", () => {
		expect(extractTextContent(null)).toBe("");
		expect(extractTextContent(undefined)).toBe("");
	});

	it("returns string as-is", () => {
		expect(extractTextContent("hello")).toBe("hello");
	});

	it("returns empty string for empty array", () => {
		expect(extractTextContent([])).toBe("");
	});

	it("extracts text from text blocks", () => {
		const content = [
			{ type: "text", text: "Hello" },
			{ type: "text", text: "World" },
		];
		expect(extractTextContent(content)).toBe("Hello\nWorld");
	});

	it("ignores non-text blocks", () => {
		const content = [
			{ type: "text", text: "Only this" },
			{ type: "toolCall", name: "read", arguments: {} },
			{ type: "image", source: "..." },
		];
		expect(extractTextContent(content)).toBe("Only this");
	});

	it("returns trimmed result", () => {
		const content = [{ type: "text", text: "  spaced  " }];
		expect(extractTextContent(content)).toBe("spaced");
	});

	it("skips blocks without text property", () => {
		const content = [{ type: "text" }, { type: "text", text: "ok" }];
		expect(extractTextContent(content)).toBe("ok");
	});
});

// ── extractToolCallNames ───────────────────────────────────────────────────

describe("extractToolCallNames", () => {
	it("returns empty array for non-array input", () => {
		expect(extractToolCallNames(null)).toEqual([]);
		expect(extractToolCallNames("string")).toEqual([]);
		expect(extractToolCallNames(undefined)).toEqual([]);
	});

	it("extracts names from toolCall blocks", () => {
		const content = [
			{ type: "toolCall", name: "read", arguments: {} },
			{ type: "toolCall", name: "edit", arguments: {} },
		];
		expect(extractToolCallNames(content)).toEqual(["read", "edit"]);
	});

	it("ignores non-toolCall blocks", () => {
		const content = [
			{ type: "text", text: "hello" },
			{ type: "toolCall", name: "bash", arguments: {} },
		];
		expect(extractToolCallNames(content)).toEqual(["bash"]);
	});

	it("returns empty array for no tool calls", () => {
		const content = [{ type: "text", text: "just text" }];
		expect(extractToolCallNames(content)).toEqual([]);
	});

	it("skips blocks without name property", () => {
		const content = [
			{ type: "toolCall", arguments: {} },
			{ type: "toolCall", name: "rg", arguments: {} },
		];
		expect(extractToolCallNames(content)).toEqual(["rg"]);
	});
});

// ── formatTimestamp ────────────────────────────────────────────────────────

describe("formatTimestamp", () => {
	it("returns HH:MM:SS format", () => {
		const result = formatTimestamp(new Date(2025, 0, 15, 9, 5, 3));
		expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	it("pads single digits with zero", () => {
		const result = formatTimestamp(new Date(2025, 0, 15, 9, 5, 3));
		expect(result).toBe("09:05:03");
	});

	it("uses current time when no date provided", () => {
		const result = formatTimestamp();
		expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});
});

// ── formatDateTime ────────────────────────────────────────────────────────

describe("formatDateTime", () => {
	it("returns YYYY-MM-DD HH:MM:SS format", () => {
		const result = formatDateTime(new Date(2025, 0, 15, 9, 5, 3));
		expect(result).toBe("2025-01-15 09:05:03");
	});

	it("pads single digits with zero", () => {
		const result = formatDateTime(new Date(2025, 11, 1, 22, 16, 14));
		expect(result).toBe("2025-12-01 22:16:14");
	});

	it("uses current datetime when no date provided", () => {
		const result = formatDateTime();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

// ── formatObservation ──────────────────────────────────────────────────────

describe("formatObservation", () => {
	it("produces correct structure with tool results", () => {
		const result = formatObservation(
			1,
			"Create login",
			[
				{ name: "read", result: "file content" },
				{ name: "edit", result: "saved" },
			],
			"Added form",
			new Date(2025, 0, 15, 10, 30, 0),
		);

		const lines = result.split("\n");
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("## Obs #1 (10:30:00)");
		expect(lines[2]).toBe('User: "Create login"');
		expect(lines[3]).toBe("Tools:");
		expect(lines[4]).toBe('  read → "file content"');
		expect(lines[5]).toBe('  edit → "saved"');
		expect(lines[6]).toBe('Agent: "Added form"');
	});

	it("marks tool errors", () => {
		const result = formatObservation(1, "hi", [{ name: "bash", result: "not found", isError: true }], "ok");
		expect(result).toContain('  bash → [error] "not found"');
	});

	it("shows tool name without result when result empty", () => {
		const result = formatObservation(1, "hi", [{ name: "read" }], "ok");
		expect(result).toContain("  read");
	});

	it("shows (none) when no tools called", () => {
		const result = formatObservation(2, "Hello", [], "Hi", new Date(2025, 0, 15, 10, 0, 0));
		expect(result).toContain("Tools: (none)");
	});

	it("shows (no response) when agent response is empty", () => {
		const result = formatObservation(3, "Test", [{ name: "bash" }], "", new Date(2025, 0, 15, 10, 0, 0));
		expect(result).toContain("Agent: (no response)");
	});

	it("truncates long user prompt to token budget", () => {
		const longPrompt = "x".repeat(20000); // ~5000 tokens
		const result = formatObservation(1, longPrompt, [], "ok");
		const userLine = result.split("\n").find((l) => l.startsWith("User:"));
		expect(userLine?.length).toBeLessThan(20000);
		expect(userLine?.length).toBeGreaterThan(4000); // budget 1000 tokens ≈ 4000 chars
		expect(userLine).toContain("[truncated");
	});

	it("truncates long agent response to token budget", () => {
		const longResponse = "y".repeat(20000); // ~5000 tokens
		const result = formatObservation(1, "hi", [], longResponse);
		const agentLine = result.split("\n").find((l) => l.startsWith("Agent:"));
		expect(agentLine?.length).toBeLessThan(20000);
		expect(agentLine?.length).toBeGreaterThan(8000); // budget 2000 tokens ≈ 8000 chars
		expect(agentLine).toContain("[truncated");
	});

	it("truncates long tool results to token budget", () => {
		const longResult = "z".repeat(10000); // ~2500 tokens
		const result = formatObservation(1, "hi", [{ name: "bash", result: longResult }], "ok");
		const toolLine = result.split("\n").find((l) => l.includes("bash →"));
		expect(toolLine?.length).toBeLessThan(10000);
		expect(toolLine?.length).toBeGreaterThan(2000); // budget 500 tokens ≈ 2000 chars
		expect(toolLine).toContain("[truncated");
	});

	it("does not truncate content within token budget", () => {
		const short = "abc".repeat(100); // ~75 tokens
		const result = formatObservation(1, short, [{ name: "read", result: short }], short);
		expect(result).toContain("abc".repeat(100));
		expect(result).not.toContain("[truncated");
	});
});

describe("estimateTokens", () => {
	it("estimates ~4 chars per token", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("a".repeat(100))).toBe(25);
	});

	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("rounds up partial tokens", () => {
		expect(estimateTokens("abc")).toBe(1);
		expect(estimateTokens("a")).toBe(1);
	});
});

describe("truncateToTokens", () => {
	it("returns text unchanged when within budget", () => {
		const text = "short text";
		expect(truncateToTokens(text, 100)).toBe(text);
	});

	it("appends truncation marker when over budget", () => {
		const text = "x".repeat(4000); // ~1000 tokens
		const result = truncateToTokens(text, 250); // budget 250 tokens ≈ 1000 chars
		expect(result).toContain("[truncated:");
		expect(result).toContain("tokens omitted]");
		expect(result.length).toBeGreaterThan(1000);
		expect(result.length).toBeLessThan(4000);
	});

	it("reports approximate omitted token count", () => {
		const text = "x".repeat(8000); // ~2000 tokens
		const result = truncateToTokens(text, 1000); // keeps ~1000 tokens
		expect(result).toMatch(/truncated: ~\d+ tokens omitted/);
	});

	it("handles empty string", () => {
		expect(truncateToTokens("", 10)).toBe("");
	});
});

describe("extractToolCalls", () => {
	it("returns empty for non-array input", () => {
		expect(extractToolCalls(null)).toEqual([]);
		expect(extractToolCalls("str")).toEqual([]);
	});

	it("extracts id and name from toolCall blocks", () => {
		const content = [
			{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
			{ type: "toolCall", id: "call_2", name: "bash", arguments: {} },
		];
		expect(extractToolCalls(content)).toEqual([
			{ id: "call_1", name: "read" },
			{ id: "call_2", name: "bash" },
		]);
	});

	it("ignores non-toolCall blocks", () => {
		const content = [
			{ type: "text", text: "hi" },
			{ type: "toolCall", id: "c1", name: "grep", arguments: {} },
		];
		expect(extractToolCalls(content)).toEqual([{ id: "c1", name: "grep" }]);
	});

	it("handles missing id", () => {
		const content = [{ type: "toolCall", name: "read", arguments: {} }];
		expect(extractToolCalls(content)).toEqual([{ id: "", name: "read" }]);
	});
});

describe("extractToolResultText", () => {
	it("returns string as-is", () => {
		expect(extractToolResultText("plain text")).toBe("plain text");
	});

	it("returns empty for null/undefined", () => {
		expect(extractToolResultText(null)).toBe("");
		expect(extractToolResultText(undefined)).toBe("");
	});

	it("extracts from content blocks array", () => {
		const result = { content: [{ type: "text", text: "output here" }] };
		expect(extractToolResultText(result)).toBe("output here");
	});

	it("extracts from direct text field", () => {
		expect(extractToolResultText({ text: "direct" })).toBe("direct");
	});

	it("extracts from output field", () => {
		expect(extractToolResultText({ output: "bash out" })).toBe("bash out");
	});

	it("returns empty for unrelated objects", () => {
		expect(extractToolResultText({ foo: "bar" })).toBe("");
	});
});

// ── formatSessionHeader ────────────────────────────────────────────────────

describe("formatSessionHeader", () => {
	it("includes session hash and date", () => {
		const result = formatSessionHeader("abc123", "2025-01-15");
		expect(result).toBe("# Session abc123 — 2025-01-15");
	});

	it("uses today's date when not provided", () => {
		const today = new Date().toISOString().slice(0, 10);
		const result = formatSessionHeader("abc123");
		expect(result).toContain(today);
	});
});

// ── countObservations ──────────────────────────────────────────────────────

describe("countObservations", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-count-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns 0 for non-existent file", () => {
		expect(countObservations(join(tmpDir, "nonexistent.md"))).toBe(0);
	});

	it("returns 0 for file with no observations", () => {
		const f = join(tmpDir, "header-only.md");
		writeFileSync(f, "# Session abc — 2025-01-15\n");
		expect(countObservations(f)).toBe(0);
	});

	it("counts observations correctly", () => {
		const f = join(tmpDir, "with-obs.md");
		writeFileSync(
			f,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'User: "hi"',
				"Tools: (none)",
				'Agent: "hello"',
				"",
				"## Obs #2 (10:01:00)",
				'User: "how?"',
				"Tools: read",
				'Agent: "like this"',
				"",
			].join("\n"),
		);
		expect(countObservations(f)).toBe(2);
	});

	it("counts multiple observations", () => {
		const f = join(tmpDir, "multi-obs.md");
		writeFileSync(
			f,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'User: "first"',
				"Tools: (none)",
				'Agent: "ok"',
				"",
				"## Obs #5 (10:05:00)",
				'User: "fifth"',
				"Tools: read",
				'Agent: "done"',
				"",
			].join("\n"),
		);
		expect(countObservations(f)).toBe(2);
	});

	it("does not count '## Obs #' inside observation content", () => {
		const f = join(tmpDir, "content-collision.md");
		writeFileSync(
			f,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'User: "vi ## Obs #3 no arquivo e ## Obs #7"',
				'Agent: "mencionei ## Obs #99 aqui"',
				"",
			].join("\n"),
		);
		expect(countObservations(f)).toBe(1);
	});

	it("does not count indented '## Obs #' lines (tool results)", () => {
		const f = join(tmpDir, "indented-collision.md");
		writeFileSync(
			f,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'Agent: "veja:"',
				"  ## Obs #2 (isto é conteúdo, não cabeçalho)",
				"",
			].join("\n"),
		);
		expect(countObservations(f)).toBe(1);
	});

	it("ignores '## Obs #' without number", () => {
		const f = join(tmpDir, "no-number.md");
		writeFileSync(
			f,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				"## Obs # (formato inválido)",
				"",
			].join("\n"),
		),
			expect(countObservations(f)).toBe(1);
	});
});

// ── ensureFileDir ──────────────────────────────────────────────────────────

describe("ensureFileDir", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-filedir-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates directory for a file path", () => {
		const nested = join(tmpDir, "a", "b", "c", "file.md");
		ensureFileDir(nested);
		expect(existsSync(join(tmpDir, "a", "b", "c"))).toBeTrue();
	});

	it("does not throw if directory already exists", () => {
		const nested = join(tmpDir, "exists", "file.md");
		ensureFileDir(nested);
		ensureFileDir(nested);
		expect(existsSync(join(tmpDir, "exists"))).toBeTrue();
	});
});

// ── Tool schemas (structural validation) ───────────────────────────────────

describe("getObservationStatus", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-status-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns threshold of 50", () => {
		const status = getObservationStatus("proj", "hash123");
		expect(status.threshold).toBe(50);
		expect(OBSERVATION_THRESHOLD).toBe(50);
	});

	it("returns 0 observations for non-existent session file", () => {
		const status = getObservationStatus("proj", "nonexistent", "2025-01-15");
		expect(status.observation_count).toBe(0);
	});

	it("counts observations from session file", () => {
		const date = "2025-01-15";
		const fp = getSessionFilePath("__status_test", "statushash", date);
		ensureFileDir(fp);
		writeFileSync(
			fp,
			[
				"# Session statushash — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'User: "hi"',
				"Tools: (none)",
				'Agent: "hello"',
				"",
				"## Obs #2 (10:01:00)",
				'User: "how"',
				"Tools: read",
				'Agent: "ok"',
				"",
			].join("\n"),
		);

		const status = getObservationStatus("__status_test", "statushash", date);
		expect(status.observation_count).toBe(2);

		// cleanup: file + test project directories
		rmSync(fp, { force: true });
		rmSync(join(MEMORIES_ROOT, "projects", "__status_test"), { recursive: true, force: true });
	});
});

describe("archiveSessionFile", () => {
	it("copies session file to archive dir, keeping original intact", () => {
		const date = "2026-08-02";
		const fp = getSessionFilePath("__archive_test", "archhash", date);
		ensureFileDir(fp);
		writeFileSync(fp, "# Session archhash\n\n## Obs #1\nUser: \"x\"\n");

		const archivePath = archiveSessionFile(fp);

		expect(archivePath).toContain("archive");
		expect(existsSync(archivePath)).toBeTrue();
		expect(readFileSync(archivePath, "utf-8")).toContain("## Obs #1");
		expect(readFileSync(fp, "utf-8")).toContain("## Obs #1"); // original intacto

		rmSync(join(MEMORIES_ROOT, "projects", "__archive_test"), {
			recursive: true,
			force: true,
		});
	});

	it("returns archive path even when file is missing", () => {
		const fp = getSessionFilePath("__archive_test2", "h", "2026-08-02");
		const archivePath = archiveSessionFile(fp);
		expect(archivePath).toContain("archive");
		rmSync(join(MEMORIES_ROOT, "projects", "__archive_test2"), {
			recursive: true,
			force: true,
		});
	});
});

describe("resetSessionFile", () => {
	it("resets a session file to header only", () => {
		const date = "2026-07-31";
		const fp = getSessionFilePath("__reset_test", "resethash", date);
		ensureFileDir(fp);

		// Create file with observations
		writeFileSync(
			fp,
			[
				"# Session resethash — 2026-07-31",
				"",
				"## Obs #1 (10:00:00)",
				'User: "hi"',
				"Tools: (none)",
				'Agent: "hello"',
				"",
				"## Obs #2 (10:01:00)",
				'User: "again"',
				"Tools: bash",
				'Agent: "ok"',
				"",
			].join("\n"),
		);

		resetSessionFile(fp, "resethash");

		const content = readFileSync(fp, "utf-8");
		// resetSessionFile writes the header with today's date
		const today = new Date().toISOString().slice(0, 10);
		expect(content).toBe(`# Session resethash — ${today}\n`);
		expect(countObservations(fp)).toBe(0);

		rmSync(join(MEMORIES_ROOT, "projects", "__reset_test"), { recursive: true, force: true });
	});

	it("creates file if it doesn't exist", () => {
		const date = "2026-07-31";
		const fp = getSessionFilePath("__reset_test2", "resethash2", date);

		resetSessionFile(fp, "resethash2");

		expect(existsSync(fp)).toBeTrue();
		const content = readFileSync(fp, "utf-8");
		expect(content).toContain("# Session resethash2");

		rmSync(join(MEMORIES_ROOT, "projects", "__reset_test2"), { recursive: true, force: true });
	});
});

describe("shouldPromptExtraction", () => {
	it("does not prompt below threshold", () => {
		const r = shouldPromptExtraction(49, -1);
		expect(r.prompt).toBeFalse();
		expect(r.bucket).toBe(0);
	});

	it("prompts at threshold crossing", () => {
		const r = shouldPromptExtraction(50, -1);
		expect(r.prompt).toBeTrue();
		expect(r.bucket).toBe(1);
	});

	it("prompts above threshold", () => {
		const r = shouldPromptExtraction(67, -1);
		expect(r.prompt).toBeTrue();
		expect(r.bucket).toBe(1);
	});

	it("does not prompt again within same bucket", () => {
		// already flagged in bucket 1 (50-99)
		const r = shouldPromptExtraction(80, 1);
		expect(r.prompt).toBeFalse();
	});

	it("prompts again at next threshold crossing", () => {
		const r = shouldPromptExtraction(100, 1);
		expect(r.prompt).toBeTrue();
		expect(r.bucket).toBe(2);
	});

	it("accepts custom threshold", () => {
		const r = shouldPromptExtraction(5, -1, 5);
		expect(r.prompt).toBeTrue();
		expect(r.bucket).toBe(1);
	});

	it("handles count at exactly 0", () => {
		const r = shouldPromptExtraction(0, -1);
		expect(r.prompt).toBeFalse();
		expect(r.bucket).toBe(0);
	});
});

describe("shouldRemindSave", () => {
	it("does not remind when no code change tools used", () => {
		expect(shouldRemindSave(["read", "bash"], 1, 0)).toBeFalse();
	});

	it("reminds on edit/write/apply_patch", () => {
		expect(shouldRemindSave(["edit"], 5, 0)).toBeTrue();
		expect(shouldRemindSave(["write"], 5, 0)).toBeTrue();
		expect(shouldRemindSave(["apply_patch"], 5, 0)).toBeTrue();
	});

	it("respects cooldown", () => {
		expect(shouldRemindSave(["edit"], 3, 1)).toBeFalse(); // 3-1=2 < 5
		expect(shouldRemindSave(["edit"], 6, 1)).toBeTrue(); // 6-1=5 >= 5
	});

	it("accepts custom cooldown", () => {
		expect(shouldRemindSave(["edit"], 2, 0, 3)).toBeFalse(); // 2-0=2 < 3
		expect(shouldRemindSave(["edit"], 3, 0, 3)).toBeTrue(); // 3-0=3 >= 3
	});

	it("reminds even if other tools called alongside", () => {
		expect(shouldRemindSave(["read", "edit", "bash"], 5, 0)).toBeTrue();
	});
});

// ── Memory decay ───────────────────────────────────────────────────────────

describe("buildTurnFingerprint", () => {
	it("includes sorted tool call ids and text", () => {
		const content = [
			{ type: "toolCall", id: "call_b", name: "edit" },
			{ type: "text", text: "resposta" },
			{ type: "toolCall", id: "call_a", name: "read" },
		];
		expect(buildTurnFingerprint(content)).toBe("call_a,call_b|resposta");
	});

	it("is stable for identical content", () => {
		const content = [{ type: "text", text: "hello" }];
		expect(buildTurnFingerprint(content)).toBe(buildTurnFingerprint(content));
	});

	it("differs when text differs", () => {
		expect(buildTurnFingerprint([{ type: "text", text: "a" }])).not.toBe(
			buildTurnFingerprint([{ type: "text", text: "b" }]),
		);
	});

	it("handles empty content", () => {
		expect(buildTurnFingerprint([])).toBe("|");
	});
});

describe("nextTurnDedup", () => {
	it("skips the same turnIndex (duplicated turn_end)", () => {
		let state = createTurnDedupState();
		const first = nextTurnDedup(3, "fp1", state);
		expect(first.skip).toBeFalse();
		state = first.state;

		const dup = nextTurnDedup(3, "fp1", state);
		expect(dup.skip).toBeTrue();
	});

	it("processes a new turnIndex", () => {
		let state = createTurnDedupState();
		state = nextTurnDedup(3, "fp1", state).state;
		const next = nextTurnDedup(4, "fp2", state);
		expect(next.skip).toBeFalse();
	});

	it("allows identical content across different turnIndexes (legit turns)", () => {
		let state = createTurnDedupState();
		state = nextTurnDedup(3, "same", state).state;
		// turnIndex available → trust the index, not the fingerprint
		const next = nextTurnDedup(4, "same", state);
		expect(next.skip).toBeFalse();
	});

	it("falls back to fingerprint when turnIndex is undefined", () => {
		let state = createTurnDedupState();
		const first = nextTurnDedup(undefined, "fpX", state);
		expect(first.skip).toBeFalse();
		state = first.state;

		const dup = nextTurnDedup(undefined, "fpX", state);
		expect(dup.skip).toBeTrue();

		const diff = nextTurnDedup(undefined, "fpY", state);
		expect(diff.skip).toBeFalse();
	});

	it("never skips empty fingerprint", () => {
		let state = createTurnDedupState();
		const first = nextTurnDedup(undefined, "", state);
		expect(first.skip).toBeFalse();
		state = first.state;
		expect(nextTurnDedup(undefined, "", state).skip).toBeFalse();
	});
});

