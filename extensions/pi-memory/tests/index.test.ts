/**
 * Tests for pi-memory (Parts 1-3: Scaffold, Observations, Tool stubs).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
	applyDecay,
	archiveSessionFile,
	buildExtractionPrompt,
	buildSearchPattern,
	countObservations,
	ensureDirectories,
	ensureFileDir,
	estimateTokens,
	extractEntryConfidences,
	findMemoryFile,
	extractTextContent,
	extractToolCallNames,
	extractToolCalls,
	extractToolResultText,
	formatFrontmatter,
	formatMemoryEntry,
	formatObservation,
	formatSessionHeader,
	formatDateTime,
	formatTimestamp,
	generateSessionHash,
	getMemoryDirectories,
	getMemoryFilePath,
	getObservationStatus,
	getSessionFilePath,
	getSupersedesPath,
	hashSessionFile,
	identifyProject,
	listMemoryContexts,
	MAX_MEMORY_SEARCH_ATTEMPTS,
	MEMORIES_ROOT,
	MEMORY_TYPES,
	moveToSupersedes,
	OBSERVATION_THRESHOLD,
	parseExtractionResult,
	parseFrontmatter,
	readFileConfidence,
	recalcOverallConfidence,
	removeProcessedObservations,
	resetSessionFile,
	sanitizeFilename,
	saveMemory,
	searchMemories,
	selectObservationsBatch,
	shouldPromptExtraction,
	shouldRemindSave,
	splitObservations,
	truncateToTokens,
} from "../utils.ts";

import {
	DecaySchema,
	ExtractSchema,
	MemoryTypeEnum,
	SaveSchema,
	SearchSchema,
	StatusSchema,
} from "../schemas.ts";

// ── Schema test helper ─────────────────────────────────────────────────────

/**
 * Checks that a schema property has a specific JSON Schema type.
 */
function propHasType(schema: object, prop: string, type: string): boolean {
	const s = schema as Record<string, unknown>;
	const props = s.properties as Record<string, unknown> | undefined;
	if (!props) return false;
	const p = props[prop] as Record<string, unknown> | undefined;
	return p?.type === type;
}

function propIsOptional(schema: object, prop: string): boolean {
	const s = schema as Record<string, unknown>;
	const required = s.required as string[] | undefined;
	if (!required) return true; // no required = all optional
	return !required.includes(prop);
}

function propIsRequired(schema: object, prop: string): boolean {
	const s = schema as Record<string, unknown>;
	const required = s.required as string[] | undefined;
	return required?.includes(prop) ?? false;
}

function schemaIsObject(schema: object): boolean {
	return (schema as Record<string, unknown>).type === "object";
}

function schemaHasProperty(schema: object, prop: string): boolean {
	const s = schema as Record<string, unknown>;
	const props = s.properties as Record<string, unknown> | undefined;
	return !!props && prop in props;
}

// ── identifyProject ────────────────────────────────────────────────────────

describe("identifyProject", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		const testProjectDir = join(MEMORIES_ROOT, "test_project");
		if (existsSync(testProjectDir)) {
			rmSync(testProjectDir, { recursive: true, force: true });
		}
	});

	it("extracts project id from git remote origin (SSH format)", () => {
		execSync("git init", { cwd: tmpDir, stdio: "pipe" });
		execSync("git remote add origin git@github.com:user/my-project.git", {
			cwd: tmpDir,
			stdio: "pipe",
		});
		expect(identifyProject(tmpDir)).toBe("github.com_user_my-project");
	});

	it("extracts project id from git remote origin (HTTPS format)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-https-"));
		execSync("git init", { cwd: dir, stdio: "pipe" });
		execSync("git remote add origin https://github.com/org/repo-name.git", {
			cwd: dir,
			stdio: "pipe",
		});
		expect(identifyProject(dir)).toBe("github.com_org_repo-name");
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to __unmanaged_<hash> when no git remote", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-nogit-"));
		const result = identifyProject(dir);
		expect(result).toMatch(/^__unmanaged_[a-f0-9]{12}$/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back when cwd does not exist", () => {
		const result = identifyProject("/non/existent/path/xyz123");
		expect(result).toMatch(/^__unmanaged_[a-f0-9]{12}$/);
	});

	it("is deterministic for the same cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-det-"));
		const a = identifyProject(dir);
		const b = identifyProject(dir);
		expect(a).toBe(b);
		rmSync(dir, { recursive: true, force: true });
	});
});

// ── getMemoryDirectories ──────────────────────────────────────────────────

describe("getMemoryDirectories", () => {
	it("returns MEMORIES_ROOT as first entry", () => {
		const dirs = getMemoryDirectories("test_project");
		expect(dirs[0]).toBe(MEMORIES_ROOT);
	});

	it("includes all 5 global type directories under _global", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, "_global", t));
		}
	});

	it("includes supersedes directories for all global types", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, ".supersedes", "_global", t));
		}
	});

	it("includes all 5 project type directories", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, "projects", "test_project", t));
		}
	});

	it("includes sessions directory for project", () => {
		const dirs = getMemoryDirectories("test_project");
		expect(dirs).toContain(join(MEMORIES_ROOT, "projects", "test_project", "sessions"));
	});

	it("includes supersedes project directories", () => {
		const dirs = getMemoryDirectories("test_project");
		for (const t of MEMORY_TYPES) {
			expect(dirs).toContain(join(MEMORIES_ROOT, ".supersedes", "projects", "test_project", t));
		}
	});

	it("returns correct number of directories", () => {
		const dirs = getMemoryDirectories("test_project");
		expect(dirs).toHaveLength(1 + 5 + 5 + 5 + 1 + 5);
	});
});

// ── ensureDirectories ──────────────────────────────────────────────────────

describe("ensureDirectories", () => {
	const TEST_PROJECT = "ensure_test";

	afterAll(() => {
		// Remove APENAS o que o teste cria (projects/ensure_test).
		// NUNCA remover MEMORIES_ROOT nem _global/<types>: podem conter
		// memórias reais do usuário. A versão antiga deletava MEMORIES_ROOT
		// inteiro (recursive) a cada execução do bun test — destruía memórias
		// globais e de todos os projetos.
		const testDirs = [
			join(MEMORIES_ROOT, "projects", TEST_PROJECT),
			join(MEMORIES_ROOT, ".supersedes", "projects", TEST_PROJECT),
		];
		for (const dir of testDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates all directories for the given project", () => {
		const created = ensureDirectories(TEST_PROJECT);
		for (const dir of created) {
			expect(existsSync(dir)).toBeTrue();
		}
	});

	it("is idempotent (safe to call twice)", () => {
		const first = ensureDirectories(TEST_PROJECT);
		const second = ensureDirectories(TEST_PROJECT);
		expect(second).toEqual(first);
		for (const dir of second) {
			expect(existsSync(dir)).toBeTrue();
		}
	});

	it("returns all expected paths", () => {
		const dirs = ensureDirectories(TEST_PROJECT);
		expect(Array.isArray(dirs)).toBeTrue();
		expect(dirs.length).toBeGreaterThan(0);
	});
});

// ── Session hashing ────────────────────────────────────────────────────────

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

describe("memory_status schema", () => {
	it("is an object schema with no properties", () => {
		expect(schemaIsObject(StatusSchema)).toBeTrue();
		const props = (StatusSchema as Record<string, unknown>).properties as Record<string, unknown>;
		expect(Object.keys(props)).toHaveLength(0);
	});
});

describe("memory_save schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(SaveSchema)).toBeTrue();
	});

	it("has required fields: type, context, title, content, scope", () => {
		expect(propIsRequired(SaveSchema, "type")).toBeTrue();
		expect(propIsRequired(SaveSchema, "context")).toBeTrue();
		expect(propIsRequired(SaveSchema, "title")).toBeTrue();
		expect(propIsRequired(SaveSchema, "content")).toBeTrue();
		expect(propIsRequired(SaveSchema, "scope")).toBeTrue();
	});

	it("has optional fields: tags, confidence, supersedes", () => {
		expect(propIsOptional(SaveSchema, "tags")).toBeTrue();
		expect(propIsOptional(SaveSchema, "confidence")).toBeTrue();
		expect(propIsOptional(SaveSchema, "supersedes")).toBeTrue();
	});

	it("has optional mode field (append|consolidate)", () => {
		expect(propIsOptional(SaveSchema, "mode")).toBeTrue();
		const s = SaveSchema as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const mode = props.mode as Record<string, unknown>;
		const variants = (mode.anyOf ?? mode.oneOf ?? []) as Array<Record<string, unknown>>;
		const values = variants.map((v) => v.const);
		expect(values).toContain("append");
		expect(values).toContain("consolidate");
	});

	it("type field is a union of literal strings", () => {
		expect(schemaHasProperty(SaveSchema, "type")).toBeTrue();
		const s = SaveSchema as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const typeProp = props.type as Record<string, unknown>;
		// StringEnum creates a union (anyOf) of literals
		const variants = (typeProp.anyOf ?? typeProp.oneOf ?? []) as Array<Record<string, unknown>>;
		expect(variants.length).toBeGreaterThan(0);
		const values = variants.map((v) => v.const);
		expect(values).toContain("_rules");
		expect(values).toContain("patterns");
	});
});

describe("memory_search schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(SearchSchema)).toBeTrue();
	});

	it("has required: query", () => {
		expect(propIsRequired(SearchSchema, "query")).toBeTrue();
	});

	it("has optional: scope, type, min_confidence, limit", () => {
		expect(propIsOptional(SearchSchema, "scope")).toBeTrue();
		expect(propIsOptional(SearchSchema, "type")).toBeTrue();
		expect(propIsOptional(SearchSchema, "min_confidence")).toBeTrue();
		expect(propIsOptional(SearchSchema, "limit")).toBeTrue();
	});

	it("query is an array of strings", () => {
		expect(propHasType(SearchSchema, "query", "array")).toBeTrue();
		const s = SearchSchema as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const q = props.query as Record<string, unknown>;
		const items = q.items as Record<string, unknown>;
		expect(items.type).toBe("string");
	});
});

describe("memory_decay schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(DecaySchema)).toBeTrue();
	});

	it("has required: context, delta", () => {
		expect(propIsRequired(DecaySchema, "context")).toBeTrue();
		expect(propIsRequired(DecaySchema, "delta")).toBeTrue();
	});

	it("has optional: move_to_supersedes, reason", () => {
		expect(propIsOptional(DecaySchema, "move_to_supersedes")).toBeTrue();
		expect(propIsOptional(DecaySchema, "reason")).toBeTrue();
	});

	it("delta is number type", () => {
		// Number in typebox can be "number" or "integer" in JSON Schema
		const s = DecaySchema as Record<string, unknown>;
		const props = s.properties as Record<string, unknown>;
		const delta = props.delta as Record<string, unknown>;
		expect(["number", "integer"]).toContain(delta.type);
	});
});

describe("memory_extract schema", () => {
	it("is an object schema", () => {
		expect(schemaIsObject(ExtractSchema)).toBeTrue();
	});

	it("has optional session_file", () => {
		expect(schemaHasProperty(ExtractSchema, "session_file")).toBeTrue();
		expect(propIsOptional(ExtractSchema, "session_file")).toBeTrue();
	});
});

describe("MemoryTypeEnum values", () => {
	it("is a union of literal strings", () => {
		const e = MemoryTypeEnum as Record<string, unknown>;
		expect(e.anyOf ?? e.oneOf ?? e.enum).toBeDefined();
	});

	it("contains all 5 memory types", () => {
		const e = MemoryTypeEnum as Record<string, unknown>;
		const variants = (e.anyOf ?? e.oneOf ?? []) as Array<Record<string, unknown>>;
		if (variants.length > 0) {
			// Union of literals: each is { type: "string", const: "..." }
			const values = variants.map((v) => v.const);
			expect(values).toContain("_rules");
			expect(values).toContain("decisions");
			expect(values).toContain("gotchas");
			expect(values).toContain("lessons");
			expect(values).toContain("patterns");
		}
	});
});

describe("ScopeEnum values", () => {
	it("contains global and project", async () => {
		const { ScopeEnum } = await import("../schemas.ts");
		const s = ScopeEnum as Record<string, unknown>;
		const variants = (s.anyOf ?? s.oneOf ?? []) as Array<Record<string, unknown>>;
		const values = variants.map((v) => v.const);
		expect(values).toContain("global");
		expect(values).toContain("project");
	});
});

// ── Memory file helpers ────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
	it("lowercases and replaces spaces with hyphens", () => {
		
		expect(sanitizeFilename("Next.js App Router")).toBe("next-js-app-router");
	});

	it("removes non-alphanumeric characters", () => {
		expect(sanitizeFilename("React 19! @types")).toBe("react-19-types");
	});

	it("collapses multiple hyphens", () => {
		
		expect(sanitizeFilename("foo___bar!!baz")).toBe("foo-bar-baz");
	});

	it("trims leading and trailing hyphens", () => {
		
		expect(sanitizeFilename("!!hello!!")).toBe("hello");
	});

	it("returns empty string for all-special input", () => {
		
		expect(sanitizeFilename("!!!")).toBe("");
	});
});

describe("getMemoryFilePath", () => {
	it("returns path under _global for global scope", () => {
		
		const path = getMemoryFilePath("proj", "_rules", "Next.js Router", "global");
		expect(path).toContain("_global");
		expect(path).toContain("_rules");
		expect(path).toContain("next-js-router.md");
		expect(path.startsWith(MEMORIES_ROOT)).toBeTrue();
	});

	it("returns path under projects for project scope", () => {
		
		const path = getMemoryFilePath("my_project", "gotchas", "test-context", "project");
		expect(path).toContain("projects");
		expect(path).toContain("my_project");
		expect(path).toContain("gotchas");
		expect(path).toContain("test-context.md");
		expect(path.startsWith(MEMORIES_ROOT)).toBeTrue();
	});
});

describe("getSupersedesPath", () => {
	it("maps a global memory path to .supersedes", () => {
		
		const original = join(MEMORIES_ROOT, "_global", "_rules", "test.md");
		const sup = getSupersedesPath(original);
		expect(sup).toContain(".supersedes");
		expect(sup).toContain("_global");
		expect(sup).toContain("_rules");
		expect(sup).toContain("test.md");
	});

	it("maps a project memory path to .supersedes", () => {
		
		const original = join(MEMORIES_ROOT, "projects", "p1", "gotchas", "ctx.md");
		const sup = getSupersedesPath(original);
		expect(sup).toContain(".supersedes");
		expect(sup).toContain("projects");
		expect(sup).toContain("p1");
		expect(sup).toContain("ctx.md");
	});
});

describe("parseFrontmatter", () => {
	it("returns empty meta for content without frontmatter", () => {
		
		const { meta, body } = parseFrontmatter("# Just a heading\n\ncontent");
		expect(meta).toEqual({});
		expect(body).toBe("# Just a heading\n\ncontent");
	});

	it("parses simple frontmatter", () => {
		
		const fm = ["---", "context: test", "type: gotcha", "confidence: 0.7", "entries: 2", "---", "", "body here"].join("\n");
		const { meta, body } = parseFrontmatter(fm);
		expect(meta.context).toBe("test");
		expect(meta.type).toBe("gotcha");
		expect(meta.confidence).toBe(0.7);
		expect(meta.entries).toBe(2);
		expect(body.trim()).toBe("body here");
	});

	it("parses tags array", () => {
		
		const fm = ["---", 'tags: ["a", "b"]', "---", "", "body"].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.tags).toEqual(["a", "b"]);
	});

	it("handles boolean values", () => {
		
		const fm = ["---", "active: true", "done: false", "---", ""].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.active).toBeTrue();
		expect(meta.done).toBeFalse();
	});

	it("parses quoted string values", () => {
		const fm = ["---", 'reason: "substituída pela v15"', "---", ""].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.reason).toBe("substituída pela v15");
	});

	it("keeps quoted numbers as strings", () => {
		const fm = ["---", 'version: "2025-01-15"', "---", ""].join("\n");
		const { meta } = parseFrontmatter(fm);
		expect(meta.version).toBe("2025-01-15");
	});
});

describe("formatFrontmatter", () => {
	it("formats simple metadata", () => {
		
		const result = formatFrontmatter({ context: "test", type: "gotcha" });
		expect(result.startsWith("---\n")).toBeTrue();
		expect(result).toContain("context: \"test\"");
		expect(result).toContain("type: \"gotcha\"");
		expect(result.endsWith("---\n")).toBeTrue();
	});

	it("formats tags array", () => {
		
		const result = formatFrontmatter({ tags: ["nextjs", "router"] });
		expect(result).toContain('tags: ["nextjs", "router"]');
	});

	it("formats number values", () => {
		
		const result = formatFrontmatter({ confidence: 0.7, entries: 3 });
		expect(result).toContain("confidence: 0.7");
		expect(result).toContain("entries: 3");
	});

	it("quotes strings containing colons", () => {
		const result = formatFrontmatter({ reason: "substituída pela v15" });
		expect(result).toContain("reason: \"substituída pela v15\"");
	});

	it("round-trips strings with colons, quotes and newlines", () => {
		const meta = { reason: 'API "v15": substituída\nnova linha' };
		const fm = formatFrontmatter(meta);
		const { meta: parsed } = parseFrontmatter(fm + "\nbody");
		expect(parsed.reason).toBe('API "v15": substituída\nnova linha');
	});
});

describe("formatMemoryEntry", () => {
	it("formats entry with confidence", () => {
		
		const result = formatMemoryEntry("2025-01-15", "My Title", "Some content", 0.8);
		expect(result).toContain("## [2025-01-15] My Title");
		expect(result).toContain("confidence: 0.8");
		expect(result).toContain("Some content");
	});

	it("formats entry without confidence", () => {
		
		const result = formatMemoryEntry("2025-06-01", "Just Title", "Just content");
		expect(result).toContain("## [2025-06-01] Just Title");
		expect(result).not.toContain("confidence:");
		expect(result).toContain("Just content");
	});
});

describe("extractEntryConfidences", () => {
	it("extracts confidence values from body", () => {
		
		const body = ["## [2025-01-15] First", "confidence: 0.8", "", "content", "", "## [2025-01-20] Second", "confidence: 0.6", ""].join("\n");
		expect(extractEntryConfidences(body)).toEqual([0.8, 0.6]);
	});

	it("returns empty array when no confidences", () => {
		
		expect(extractEntryConfidences("just text")).toEqual([]);
	});
});

describe("recalcOverallConfidence", () => {
	it("averages confidences", () => {
		
		expect(recalcOverallConfidence([0.8, 0.6], 0.7)).toBe(0.7); // (0.8+0.6+0.7)/3 = 0.7
	});

	it("returns single confidence if no existing", () => {
		
		expect(recalcOverallConfidence([], 0.5)).toBe(0.5);
	});

	it("rounds to 2 decimal places", () => {
		
		expect(recalcOverallConfidence([0.5, 0.6], 0.7)).toBe(0.6);
	});
});

// ── Integration: memory_save (via utils helpers) ───────────────────────────

describe("memory_save integration", () => {
	let tmpRoot: string;
	let origMemoriesRoot: string;

	beforeAll(async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");
		origMemoriesRoot = MEMORIES_ROOT;
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-memory-save-"));
	});

	afterAll(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("creates a new memory file", async () => {
		const { getMemoryFilePath, ensureFileDir, formatFrontmatter, formatMemoryEntry } = await import("../utils.ts");
		const { writeFileSync, existsSync } = await import("node:fs");

		const ctx = "my-context";
		const fp = join(tmpRoot, "_global", "_rules", ctx + ".md");

		// Simulate the save logic
		const meta = { context: ctx, type: "_rules", created: "2025-01-15", updated: "2025-01-15", confidence: 0.7, entries: 1 };
		const entry = formatMemoryEntry("2025-01-15", "Test Title", "Test content", 0.7);
		ensureFileDir(fp);
		writeFileSync(fp, formatFrontmatter(meta) + entry + "\n");

		expect(existsSync(fp)).toBeTrue();
		const content = readFileSync(fp, "utf-8");
		expect(content).toContain("context: \"my-context\"");
		expect(content).toContain("## [2025-01-15] Test Title");
		expect(content).toContain("Test content");
	});

	it("appends entry to existing memory file", async () => {
		const { formatMemoryEntry, formatFrontmatter, parseFrontmatter, extractEntryConfidences, recalcOverallConfidence } = await import("../utils.ts");
		const { readFileSync, writeFileSync, existsSync } = await import("node:fs");

		const fp = join(tmpRoot, "_global", "_rules", "my-context.md");

		// Read existing, append
		const existing = readFileSync(fp, "utf-8");
		const { meta, body } = parseFrontmatter(existing);

		const confs = extractEntryConfidences(body);
		meta.confidence = recalcOverallConfidence(confs, 0.6);
		meta.updated = "2025-01-20";
		meta.entries = (meta.entries as number) + 1;

		const newEntry = formatMemoryEntry("2025-01-20", "Second Entry", "More content", 0.6);
		writeFileSync(fp, formatFrontmatter(meta) + body + newEntry + "\n");

		const updated = readFileSync(fp, "utf-8");
		expect(updated).toContain("## [2025-01-20] Second Entry");
		expect(updated).toContain("entries: 2");
		expect(updated).toContain("confidence: 0.65"); // (0.7 + 0.6) / 2
	});

	it("creates and moves to .supersedes on supersede", async () => {
		const { getSupersedesPath, ensureFileDir, formatFrontmatter, formatMemoryEntry } = await import("../utils.ts");
		const { readFileSync, writeFileSync, existsSync } = await import("node:fs");

		// Create old memory
		const oldFp = join(tmpRoot, "_global", "_rules", "old-context.md");
		const meta = { context: "old-context", type: "_rules", created: "2025-01-01", updated: "2025-01-01", confidence: 0.5, entries: 1 };
		const entry = formatMemoryEntry("2025-01-01", "Old info", "Outdated", 0.5);
		ensureFileDir(oldFp);
		writeFileSync(oldFp, formatFrontmatter(meta) + entry + "\n");

		// Move to supersedes
		const supPath = join(tmpRoot, ".supersedes", "_global", "_rules", "old-context.md");
		const oldContent = readFileSync(oldFp, "utf-8");

		// Add superseded meta
		
		const parsed = parseFrontmatter(oldContent);
		parsed.meta.superseded_at = "2025-01-15";
		parsed.meta.superseded_by = "new-context";
		parsed.meta.confidence = 0;

		ensureFileDir(supPath);
		writeFileSync(supPath, formatFrontmatter(parsed.meta) + parsed.body);

		expect(existsSync(supPath)).toBeTrue();
		const supContent = readFileSync(supPath, "utf-8");
		expect(supContent).toContain("superseded_at: \"2025-01-15\"");
		expect(supContent).toContain("superseded_by: \"new-context\"");
		expect(supContent).toContain("confidence: 0");
		expect(supContent).toContain("## [2025-01-01] Old info");
	});
});

// ── Memory search ──────────────────────────────────────────────────────────

describe("listMemoryContexts", () => {
	let testProjectId: string;

	beforeAll(() => {
		testProjectId = `__test_ctx_${Date.now()}`;
		// Memória de projeto
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "proj-gotcha.md");
		ensureFileDir(fp);
		writeFileSync(fp, "---\ncontext: proj-gotcha\n---\n\ncontent");
		// Memória global
		const gfp = join(MEMORIES_ROOT, "_global", "lessons", "glob-lesson.md");
		ensureFileDir(gfp);
		writeFileSync(gfp, "---\ncontext: glob-lesson\n---\n\ncontent");
	});

	afterAll(() => {
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, "_global", "lessons", "glob-lesson.md"), { force: true });
	});

	it("lists project context keys", () => {
		const ctx = listMemoryContexts(testProjectId);
		expect(ctx.project).toContain("proj-gotcha");
	});

	it("lists global context keys", () => {
		const ctx = listMemoryContexts(testProjectId);
		expect(ctx.global).toContain("glob-lesson");
	});

	it("returns sorted keys", () => {
		const ctx = listMemoryContexts(testProjectId);
		expect([...ctx.global].sort()).toEqual(ctx.global);
		expect([...ctx.project].sort()).toEqual(ctx.project);
	});

	it("does not include session files", () => {
		const ctx = listMemoryContexts(testProjectId);
		for (const k of [...ctx.global, ...ctx.project]) {
			expect(k).not.toMatch(/^sessions/);
		}
	});
});

describe("readFileConfidence", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-rfc-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined for non-existent file", () => {
		expect(readFileConfidence(join(tmpDir, "none.md"))).toBeUndefined();
	});

	it("returns confidence from frontmatter", () => {
		const fp = join(tmpDir, "test.md");
		writeFileSync(fp, "---\nconfidence: 0.7\n---\n\ncontent");
		expect(readFileConfidence(fp)).toBe(0.7);
	});

	it("returns undefined when no confidence in frontmatter", () => {
		const fp = join(tmpDir, "noconf.md");
		writeFileSync(fp, "---\ncontext: test\n---\n\ncontent");
		expect(readFileConfidence(fp)).toBeUndefined();
	});

	it("returns undefined for file without frontmatter", () => {
		const fp = join(tmpDir, "plain.md");
		writeFileSync(fp, "# just content");
		expect(readFileConfidence(fp)).toBeUndefined();
	});
});

describe("buildSearchPattern", () => {
	it("joins terms with | (OR semantics)", () => {
		expect(buildSearchPattern(["cache", "invalidation"])).toBe("cache|invalidation");
	});

	it("escapes regex metacharacters for literal matching", () => {
		expect(buildSearchPattern(["C++", "a.b"])).toBe("C\\+\\+|a\\.b");
	});

	it("filters empty and whitespace-only terms", () => {
		expect(buildSearchPattern(["", "foo", " "])).toBe("foo");
	});

	it("returns empty string for empty input", () => {
		expect(buildSearchPattern([])).toBe("");
	});
});

describe("MAX_MEMORY_SEARCH_ATTEMPTS", () => {
	it("is 3", () => {
		expect(MAX_MEMORY_SEARCH_ATTEMPTS).toBe(3);
	});
});

describe("searchMemories", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_search_${Date.now()}`;
		const { MEMORIES_ROOT } = await import("../utils.ts");

		// Write a test file to the real MEMORIES_ROOT under a temp project
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "test-memory.md");
		ensureFileDir(fp);
		writeFileSync(
			fp,
			[
				"---",
				"context: test-memory",
				"type: gotchas",
				"confidence: 0.7",
				"---",
				"",
				"## [2025-01-15] Test Memory",
				"confidence: 0.7",
				"",
				"This is a test memory about unicorns and rainbows.",
			].join("\n"),
		);

		// Also a global file
		const globalFp = join(MEMORIES_ROOT, "_global", "_rules", "test-global.md");
		ensureFileDir(globalFp);
		writeFileSync(
			globalFp,
			[
				"---",
				"context: test-global",
				"type: _rules",
				"confidence: 0.8",
				"---",
				"",
				"## [2025-01-10] Global Rule",
				"",
				"Always test memory search functions.",
			].join("\n"),
		);

		// Session file com keyword única (não deve aparecer nos resultados)
		const sessionFp = join(
			MEMORIES_ROOT,
			"projects",
			testProjectId,
			"sessions",
			"2026-08-02",
			"sesstest-hash.md",
		);
		ensureFileDir(sessionFp);
		writeFileSync(
			sessionFp,
			'# Session sesstest\n\n## Obs #1\nUser: "busca-session-exclusiva-xyz"\n',
		);
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");
		const testDir = join(MEMORIES_ROOT, "projects", testProjectId);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

		const globalFile = join(MEMORIES_ROOT, "_global", "_rules", "test-global.md");
		if (existsSync(globalFile)) rmSync(globalFile);
	});

	it("returns empty array for non-matching query", () => {
		const results = searchMemories({
			query: "zzzxyznonexistent_12345",
			projectId: testProjectId,
			limit: 5,
		});
		expect(results).toEqual([]);
	});

	it("finds by keyword in all scopes", () => {
		const results = searchMemories({ query: "unicorns", projectId: testProjectId, limit: 10 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		const match = results.find((r) => r.file.includes("test-memory.md"));
		expect(match).toBeDefined();
		expect(match!.lines.some((l) => l.includes("unicorns"))).toBeTrue();
	});

	it("filters by scope=global", () => {
		const results = searchMemories({ query: "test-global", scope: "global", limit: 10 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		for (const r of results) {
			expect(r.file).toContain("_global");
		}
	});

	it("filters by scope=project", () => {
		const results = searchMemories({
			query: "unicorns",
			scope: "project",
			projectId: testProjectId,
			limit: 10,
		});
		expect(results.length).toBeGreaterThanOrEqual(1);
		for (const r of results) {
			expect(r.file).toContain("projects");
		}
	});

	it("filters by type", () => {
		const results = searchMemories({ query: ".*", type: "gotchas", projectId: testProjectId, limit: 10 });
		for (const r of results) {
			expect(r.file).toContain("gotchas");
		}
	});

	it("filters by minConfidence", () => {
		const results = searchMemories({
			query: "unicorns",
			minConfidence: 0.9,
			projectId: testProjectId,
			limit: 10,
		});
		// test memory has confidence 0.7, so should be filtered out
		const match = results.find((r) => r.file.includes("test-memory.md"));
		expect(match).toBeUndefined();
	});

	it("respects limit", () => {
		const results = searchMemories({ query: "test", projectId: testProjectId, limit: 1 });
		expect(results.length).toBeLessThanOrEqual(1);
	});

	it("does not leak memories from other projects in project scope", () => {
		const otherProject = `__test_search_leak_${Date.now()}`;
		const otherFp = join(MEMORIES_ROOT, "projects", otherProject, "gotchas", "leak.md");
		ensureFileDir(otherFp);
		writeFileSync(
			otherFp,
			"---\ncontext: leak\ntype: gotchas\nconfidence: 0.7\n---\n\nunicorns from another project",
		);

		try {
			const results = searchMemories({
				query: "unicorns",
				scope: "project",
				projectId: testProjectId,
				limit: 10,
			});
			const leak = results.find((r) => r.file.includes("leak.md"));
			expect(leak).toBeUndefined();
		} finally {
			rmSync(join(MEMORIES_ROOT, "projects", otherProject), {
				recursive: true,
				force: true,
			});
		}
	});

	it("excludes session files from search", () => {
		const results = searchMemories({
			query: "busca-session-exclusiva-xyz",
			scope: "project",
			projectId: testProjectId,
			limit: 10,
		});
		const match = results.find((r) => r.file.includes("sessions"));
		expect(match).toBeUndefined();
	});

	it("excludes session files from all-scope search", () => {
		const results = searchMemories({
			query: "busca-session-exclusiva-xyz",
			projectId: testProjectId,
			limit: 10,
		});
		expect(results).toEqual([]);
	});

	it("excludes .supersedes/ files", () => {
		const results = searchMemories({
			query: "old memory",
			projectId: testProjectId,
			limit: 10,
		});
		for (const r of results) {
			expect(r.file).not.toContain(".supersedes");
		}
	});

	it("scope=all returns current project + global, never other projects", () => {
		const otherProject = `__test_search_leak_all_${Date.now()}`;
		const otherFp = join(MEMORIES_ROOT, "projects", otherProject, "gotchas", "leak-all.md");
		ensureFileDir(otherFp);
		writeFileSync(
			otherFp,
			"---\ncontext: leak-all\ntype: gotchas\nconfidence: 0.7\n---\n\nunicorns from another project",
		);

		try {
			const results = searchMemories({
				query: "unicorns",
				scope: "all",
				projectId: testProjectId,
				limit: 10,
			});
			// Encontra a memória do projeto atual
			expect(results.some((r) => r.file.includes("test-memory.md"))).toBeTrue();
			// Não vaza memória de outro projeto
			expect(results.some((r) => r.file.includes("leak-all.md"))).toBeFalse();
		} finally {
			rmSync(join(MEMORIES_ROOT, "projects", otherProject), {
				recursive: true,
				force: true,
			});
		}
	});

	it("throws without projectId for scope=project/all", () => {
		expect(() => searchMemories({ query: "x", scope: "project" })).toThrow(/projectId/);
		expect(() => searchMemories({ query: "x", scope: "all" })).toThrow(/projectId/);
	});
});

// ── Observation status ─────────────────────────────────────────────────────

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

		// cleanup: arquivo + diretórios do projeto de teste
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

		// Cria arquivo com observações
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
		// já sinalizado no bucket 1 (50-99)
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

describe("applyDecay", () => {
	it("reduces confidence by delta", () => {
		expect(applyDecay(0.7, -0.3)).toBe(0.4);
	});

	it("treats positive delta as reduction", () => {
		expect(applyDecay(0.7, 0.3)).toBe(0.4);
	});

	it("clamps at 0", () => {
		expect(applyDecay(0.3, -0.9)).toBe(0);
	});

	it("rounds to 2 decimal places", () => {
		expect(applyDecay(0.55, -0.1)).toBe(0.45);
	});

	it("keeps confidence if delta is 0", () => {
		expect(applyDecay(0.5, 0)).toBe(0.5);
	});
});

describe("findMemoryFile", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_find_${Date.now()}`;
		const { MEMORIES_ROOT } = await import("../utils.ts");

		// Create a memory in a specific location
		const fp = join(MEMORIES_ROOT, "_global", "gotchas", "findme.md");
		ensureFileDir(fp);
		writeFileSync(fp, "---\ncontext: findme\ntype: gotchas\nconfidence: 0.6\n---\n\ncontent");

		// Project-scoped memory
		const pfp = join(MEMORIES_ROOT, "projects", testProjectId, "_rules", "projrule.md");
		ensureFileDir(pfp);
		writeFileSync(pfp, "---\ncontext: projrule\ntype: _rules\nconfidence: 0.7\n---\n\ncontent");
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");
		rmSync(join(MEMORIES_ROOT, "_global", "gotchas", "findme.md"), { force: true });
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
	});

	it("finds global memory by context", () => {
		const fp = findMemoryFile("__test_find_20250101", "findme");
		expect(fp).toBeDefined();
		expect(fp!).toContain("_global");
		expect(fp!).toContain("gotchas");
	});

	it("finds project memory by context", () => {
		const fp = findMemoryFile(testProjectId, "projrule");
		expect(fp).toBeDefined();
		expect(fp!).toContain("projects");
		expect(fp!).toContain("projrule");
	});

	it("returns undefined for unknown context", () => {
		expect(findMemoryFile("whatever", "does-not-exist-xyz")).toBeUndefined();
	});
});

describe("moveToSupersedes", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_move_${Date.now()}`;
		const { MEMORIES_ROOT } = await import("../utils.ts");

		const fp = join(MEMORIES_ROOT, "_global", "_rules", "decayme.md");
		ensureFileDir(fp);
		writeFileSync(
			fp,
			[
				"---",
				"context: decayme",
				"type: _rules",
				"confidence: 0.6",
				"---",
				"",
				"## [2025-01-01] Old rule",
				"",
				"Some content here.",
			].join("\n"),
		);
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");
		rmSync(join(MEMORIES_ROOT, "_global", "_rules", "decayme.md"), { force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "_global", "_rules", "decayme.md"), { force: true });
	});

	it("moves file to .supersedes preserving structure", async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");

		const original = join(MEMORIES_ROOT, "_global", "_rules", "decayme.md");
		const supPath = moveToSupersedes(original, { superseded_reason: "test decay" });

		// Original removed
		expect(existsSync(original)).toBeFalse();

		// New file exists at expected location
		expect(supPath).toBe(join(MEMORIES_ROOT, ".supersedes", "_global", "_rules", "decayme.md"));
		expect(existsSync(supPath)).toBeTrue();

		// Content preserved with metadata
		const content = readFileSync(supPath, "utf-8");
		expect(content).toContain("context: \"decayme\"");
		expect(content).toContain("superseded_at:");
		expect(content).toContain("superseded_reason: \"test decay\"");
		expect(content).toContain("confidence: 0");
		expect(content).toContain("## [2025-01-01] Old rule");
	});
});

// ── Memory extraction ──────────────────────────────────────────────────────

describe("buildExtractionPrompt", () => {
	it("includes session content", () => {
		const prompt = buildExtractionPrompt("## Obs #1\nUser: fix bug");
		expect(prompt).toContain("## Obs #1");
		expect(prompt).toContain("fix bug");
	});

	it("includes extraction rules", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("confidence >= 0.5");
		expect(prompt).toContain("Reuse existing context keys");
		expect(prompt).toContain("JSON only");
	});

	it("mentions all 5 memory types", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("gotchas");
		expect(prompt).toContain("_rules");
		expect(prompt).toContain("decisions");
		expect(prompt).toContain("lessons");
		expect(prompt).toContain("patterns");
	});

	it("explains scope rules", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("global");
		expect(prompt).toContain("project");
	});

	it("requires PT-BR memory content", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("PT-BR");
		expect(prompt).toContain("Brazilian Portuguese");
	});

	it("includes existing context keys when provided", () => {
		const prompt = buildExtractionPrompt("content", {
			global: ["auth"],
			project: ["nextjs-router"],
		});
		expect(prompt).toContain("Existing memory context keys");
		expect(prompt).toContain("auth");
		expect(prompt).toContain("nextjs-router");
	});

	it("mentions supersedes for existing memories", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("supersedes");
	});

	it("mentions mode consolidate for updates on same context", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("consolidate");
		expect(prompt).toContain("SAME context key");
	});
});

describe("parseExtractionResult", () => {
	it("parses valid JSON with memories", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "nextjs",
					title: "params is Promise",
					content: "In Next.js...",
					scope: "project",
					confidence: 0.7,
					tags: ["nextjs"],
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("nextjs");
		expect(result[0].type).toBe("gotchas");
		expect(result[0].scope).toBe("project");
		expect(result[0].confidence).toBe(0.7);
		expect(result[0].tags).toEqual(["nextjs"]);
	});

	it("preserves supersedes field", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "new-key",
					title: "New info",
					content: "Better version",
					scope: "project",
					supersedes: "old-key",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].supersedes).toBe("old-key");
	});

	it("accepts mode consolidate", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "c",
					title: "t",
					content: "x",
					scope: "project",
					mode: "consolidate",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("consolidate");
	});

	it("rejects invalid mode", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "c",
					title: "t",
					content: "x",
					scope: "project",
					mode: "overwrite",
				},
			],
		});
		expect(parseExtractionResult(json)).toEqual([]);
	});

	it("handles markdown code fences", () => {
		const json = '```json\n{"memories": [{"type": "lessons", "context": "c", "title": "t", "content": "x", "scope": "global"}]}\n```';
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("c");
	});

	it("returns empty for invalid JSON", () => {
		expect(parseExtractionResult("not json at all")).toEqual([]);
	});

	it("returns empty when memories key missing", () => {
		expect(parseExtractionResult(JSON.stringify({ foo: "bar" }))).toEqual([]);
	});

	it("filters out incomplete memories", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "ok",
					title: "complete",
					content: "full",
					scope: "project",
				},
				{ type: "gotchas", context: "missing content" },
				{ type: "gotchas", context: "c", title: "t", content: "x", scope: "invalid" },
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("ok");
	});

	it("filters memories with non-canonical type", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "ok",
					title: "t",
					content: "c",
					scope: "project",
				},
				// singular — criaria diretório "gotcha/" no lugar de "gotchas/"
				{
					type: "gotcha",
					context: "bad-singular",
					title: "t",
					content: "c",
					scope: "project",
				},
				// sem underscore
				{
					type: "rules",
					context: "bad-rules",
					title: "t",
					content: "c",
					scope: "project",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("ok");
	});

	it("handles whitespace around JSON", () => {
		const json = `\n\n  {"memories": []}  \n`;
		expect(parseExtractionResult(json)).toEqual([]);
	});
});

describe("saveMemory (shared by memory_save/memory_extract)", () => {
	let testProjectId: string;

	beforeAll(async () => {
		testProjectId = `__test_savemem_${Date.now()}`;
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");
		rmSync(join(MEMORIES_ROOT, "projects", testProjectId), { recursive: true, force: true });
		rmSync(join(MEMORIES_ROOT, ".supersedes", "projects", testProjectId), { recursive: true, force: true });
		// "supersedes across different type and scope" cria cache-rule em
		// _global/_rules e o move para .supersedes — limpar o resíduo global
		rmSync(join(MEMORIES_ROOT, ".supersedes", "_global", "_rules", "cache-rule.md"), { force: true });
	});

	it("creates a new memory file", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "test-ctx",
			title: "Test memory",
			content: "Some rich content",
			scope: "project",
			confidence: 0.7,
		});

		expect(result.action).toBe("created");
		expect(existsSync(result.file)).toBeTrue();

		const content = readFileSync(result.file, "utf-8");
		expect(content).toContain("context: \"test-ctx\"");
		expect(content).toContain("## ");
		expect(content).toContain("Some rich content");
	});

	it("rejects non-canonical type without creating a directory", () => {
		const result = saveMemory(testProjectId, {
			type: "gotcha", // singular — criaria diretório errado
			context: "bad-type",
			title: "T",
			content: "C",
			scope: "project",
		});

		expect(result.action).toBe("error");
		expect(result.error).toBeDefined();

		// Nenhum diretório singular deve ter sido criado
		const bogusDir = join(MEMORIES_ROOT, "projects", testProjectId, "gotcha");
		expect(existsSync(bogusDir)).toBeFalse();
	});

	it("appends to existing memory file", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "test-ctx",
			title: "Second entry",
			content: "More content",
			scope: "project",
			confidence: 0.6,
		});

		expect(result.action).toBe("appended");
		expect(result.entries).toBe(2);

		const content = readFileSync(result.file, "utf-8");
		expect(content).toContain("Second entry");
		expect(content).toContain("entries: 2");
	});

	it("computes real average across multiple entries (not successive-mean distortion)", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "multi-avg",
			title: "First",
			content: "content",
			scope: "project",
			confidence: 0.7,
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "multi-avg",
			title: "Second",
			content: "content",
			scope: "project",
			confidence: 0.6,
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "multi-avg",
			title: "Third",
			content: "content",
			scope: "project",
			confidence: 0.5,
		});

		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "multi-avg.md");
		const { meta } = parseFrontmatter(readFileSync(fp, "utf-8"));
		expect(meta.confidence).toBe(0.6); // média real (0.7+0.6+0.5)/3 — sucessiva daria 0.575
		expect(meta.entries).toBe(3);
	});

	it("preserves decay across multiple entries", () => {
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-multi",
			title: "First",
			content: "content",
			scope: "project",
			confidence: 0.7,
		});
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-multi",
			title: "Second",
			content: "content",
			scope: "project",
			confidence: 0.6,
		});
		// conf agora 0.65, entries 2

		// Simula decay: reduz confidence do frontmatter para 0.3
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "decay-multi.md");
		const { meta, body } = parseFrontmatter(readFileSync(fp, "utf-8"));
		meta.confidence = 0.3;
		writeFileSync(fp, formatFrontmatter(meta) + body);

		// O decay deve pesar sobre todas as entradas: (0.3*2 + 0.5)/3 = 0.3666... → 0.37
		// (média sucessiva daria 0.4)
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-multi",
			title: "Third",
			content: "content",
			scope: "project",
			confidence: 0.5,
		});

		const updated = readFileSync(fp, "utf-8");
		const { meta: meta2 } = parseFrontmatter(updated);
		expect(meta2.confidence).toBe(0.37);
		expect(meta2.entries).toBe(3);
	});

	it("preserves decayed confidence on append", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-persist",
			title: "First",
			content: "content",
			scope: "project",
			confidence: 0.7,
		});
		expect(result.action).toBe("created");

		// Simula decay: reduz confidence do frontmatter para 0.4
		const fp = join(MEMORIES_ROOT, "projects", testProjectId, "gotchas", "decay-persist.md");
		const { meta, body } = parseFrontmatter(readFileSync(fp, "utf-8"));
		meta.confidence = 0.4;
		writeFileSync(fp, formatFrontmatter(meta) + body);

		// Append novo com 0.5 — média deve ser (0.4 + 0.5) / 2 = 0.45
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "decay-persist",
			title: "Second",
			content: "more",
			scope: "project",
			confidence: 0.5,
		});

		const updated = readFileSync(fp, "utf-8");
		const { meta: meta2 } = parseFrontmatter(updated);
		expect(meta2.confidence).toBe(0.45);
	});

	it("handles supersedes", async () => {
		// Create a superseded memory first
		saveMemory(testProjectId, {
			type: "gotchas",
			context: "old-ctx",
			title: "Old info",
			content: "Outdated",
			scope: "project",
		});

		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "new-ctx",
			title: "New info",
			content: "Better",
			scope: "project",
			supersedes: "old-ctx",
		});

		expect(result.action).toBe("created");

		// Old file should be in .supersedes now
		const { MEMORIES_ROOT } = await import("../utils.ts");
		const supPath = join(
			MEMORIES_ROOT,
			".supersedes",
			"projects",
			testProjectId,
			"gotchas",
			"old-ctx.md",
		);
		expect(existsSync(supPath)).toBeTrue();
	});

	it("supersedes across different type and scope", async () => {
		// Old memory lives in _global/_rules (type+scope diferentes do novo save)
		saveMemory(testProjectId, {
			type: "_rules",
			context: "cache-rule",
			title: "Regra antiga",
			content: "Cache deve ser invalidado manualmente",
			scope: "global",
		});

		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "cache-gotcha",
			title: "Gotcha novo",
			content: "Cache invalida sozinho",
			scope: "project",
			supersedes: "cache-rule",
		});

		expect(result.action).toBe("created");

		// Old file should be in .supersedes with _global/_rules structure
		const { MEMORIES_ROOT } = await import("../utils.ts");
		const supPath = join(
			MEMORIES_ROOT,
			".supersedes",
			"_global",
			"_rules",
			"cache-rule.md",
		);
		expect(existsSync(supPath)).toBeTrue();

		// Original must be gone
		expect(existsSync(join(MEMORIES_ROOT, "_global", "_rules", "cache-rule.md"))).toBeFalse();
	});

	it("consolidates existing memory (mode=consolidate)", () => {
		const result = saveMemory(testProjectId, {
			type: "gotchas",
			context: "consol-ctx",
			title: "v1",
			content: "conteúdo antigo",
			scope: "project",
			confidence: 0.7,
		});
		expect(result.action).toBe("created");

		const consolidated = saveMemory(testProjectId, {
			type: "gotchas",
			context: "consol-ctx",
			title: "v2",
			content: "conteúdo consolidado novo",
			scope: "project",
			mode: "consolidate",
			confidence: 0.8,
		});

		expect(consolidated.action).toBe("consolidated");

		// Arquivo novo: conteúdo v2, uma entrada, confidence limpo (sem média)
		const content = readFileSync(consolidated.file, "utf-8");
		expect(content).toContain("conteúdo consolidado novo");
		expect(content).not.toContain("conteúdo antigo");
		expect(content).toContain("entries: 1");
		expect(content).toContain("confidence: 0.8");

		// Versão antiga arquivada em .supersedes com metadados
		const supPath = join(
			MEMORIES_ROOT,
			".supersedes",
			"projects",
			testProjectId,
			"gotchas",
			"consol-ctx.md",
		);
		expect(existsSync(supPath)).toBeTrue();
		const supContent = readFileSync(supPath, "utf-8");
		expect(supContent).toContain("conteúdo antigo");
		expect(supContent).toContain("superseded_by: \"consol-ctx\"");
		expect(supContent).toContain("superseded_reason: \"consolidated\"");
	});

	it("consolidate on non-existent context creates normally", () => {
		const result = saveMemory(testProjectId, {
			type: "lessons",
			context: "consol-new",
			title: "t",
			content: "c",
			scope: "project",
			mode: "consolidate",
		});
		expect(result.action).toBe("created");
	});

	it("consolidate respects invalid type guard", () => {
		const result = saveMemory(testProjectId, {
			type: "gotcha", // singular inválido
			context: "consol-bad",
			title: "t",
			content: "c",
			scope: "project",
			mode: "consolidate",
		});
		expect(result.action).toBe("error");
	});
});

// ── Incremental extraction (split / batch / remove) ─────────────────────────

describe("splitObservations", () => {
	it("divides content into individual observations, ignoring header", () => {
		const content = [
			"# Session abc — 2025-01-15",
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
		].join("\n");
		const obs = splitObservations(content);
		expect(obs).toHaveLength(2);
		expect(obs[0]).toContain('User: "hi"');
		expect(obs[0]).not.toContain("# Session");
		expect(obs[1]).toContain('User: "how"');
	});

	it("returns empty array when no observations", () => {
		expect(splitObservations("# Session abc — 2025-01-15\n")).toEqual([]);
	});

	it("handles empty content", () => {
		expect(splitObservations("")).toEqual([]);
	});
});

describe("selectObservationsBatch", () => {
	it("selects all when within budget", () => {
		const obs = ['## Obs #1 (10:00:00)\nUser: "a"\n', '## Obs #2 (10:01:00)\nUser: "b"\n'];
		const { batch, remaining } = selectObservationsBatch(obs, 1000);
		expect(batch).toHaveLength(2);
		expect(remaining).toHaveLength(0);
	});

	it("selects prefix that fits the budget", () => {
		const obs = ["x".repeat(4000), "y".repeat(4000), "z".repeat(4000)]; // ~1000 tok cada
		const { batch, remaining } = selectObservationsBatch(obs, 2500); // cabe ~2
		expect(batch).toHaveLength(2);
		expect(remaining).toHaveLength(1);
		expect(batch[0]).toBe(obs[0]);
		expect(batch[1]).toBe(obs[1]);
		expect(remaining[0]).toBe(obs[2]);
	});

	it("guarantees at least one observation even if it overflows the budget", () => {
		const obs = ["a".repeat(100000)]; // estoura qualquer budget
		const { batch, remaining } = selectObservationsBatch(obs, 10);
		expect(batch).toHaveLength(1);
		expect(remaining).toHaveLength(0);
	});

	it("returns empty for empty input", () => {
		const { batch, remaining } = selectObservationsBatch([]);
		expect(batch).toHaveLength(0);
		expect(remaining).toHaveLength(0);
	});
});

describe("removeProcessedObservations", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-rmproc-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("removes processed observations, keeping header and remaining", () => {
		const fp = join(tmpDir, "session.md");
		writeFileSync(
			fp,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'User: "a"',
				"Tools: (none)",
				'Agent: "a1"',
				"",
				"## Obs #2 (10:01:00)",
				'User: "b"',
				"Tools: (none)",
				'Agent: "b1"',
				"",
				"## Obs #3 (10:02:00)",
				'User: "c"',
				"Tools: (none)",
				'Agent: "c1"',
				"",
			].join("\n"),
		);

		removeProcessedObservations(fp, 2);

		const updated = readFileSync(fp, "utf-8");
		expect(updated).toContain("# Session abc — 2025-01-15");
		expect(updated).not.toContain('User: "a"');
		expect(updated).not.toContain('User: "b"');
		expect(updated).toContain('User: "c"');
		expect(countObservations(fp)).toBe(1);
	});

	it("handles processed >= observations (keeps header only)", () => {
		const fp = join(tmpDir, "session2.md");
		writeFileSync(fp, "# Session abc — 2025-01-15\n\n## Obs #1 (10:00:00)\nUser: \"a\"\n");
		removeProcessedObservations(fp, 10);
		expect(countObservations(fp)).toBe(0);
		expect(readFileSync(fp, "utf-8")).toContain("# Session");
	});

	it("no-op when file has no observations", () => {
		const fp = join(tmpDir, "session3.md");
		writeFileSync(fp, "# Session abc — 2025-01-15\n");
		removeProcessedObservations(fp, 5);
		expect(readFileSync(fp, "utf-8")).toBe("# Session abc — 2025-01-15\n");
	});
});
