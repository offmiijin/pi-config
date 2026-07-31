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
	buildExtractionPrompt,
	countObservations,
	ensureDirectories,
	ensureFileDir,
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
	formatTimestamp,
	generateSessionHash,
	getMemoryDirectories,
	getMemoryFilePath,
	getObservationStatus,
	getSessionFilePath,
	getSupersedesPath,
	hashSessionFile,
	identifyProject,
	MEMORIES_ROOT,
	MEMORY_TYPES,
	moveToSupersedes,
	OBSERVATION_THRESHOLD,
	parseExtractionResult,
	parseFrontmatter,
	readFileConfidence,
	recalcOverallConfidence,
	sanitizeFilename,
	saveMemory,
	searchMemories,
	shouldPromptExtraction,
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
		const dirsToCheck = [
			MEMORIES_ROOT,
			...MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, "_global", t)),
			...MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, ".supersedes", "_global", t)),
			...MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, "projects", TEST_PROJECT, t)),
			join(MEMORIES_ROOT, "projects", TEST_PROJECT, "sessions"),
			...MEMORY_TYPES.map((t) => join(MEMORIES_ROOT, ".supersedes", "projects", TEST_PROJECT, t)),
		];
		for (const dir of dirsToCheck) {
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

	it("truncates long user prompt to 1000 chars", () => {
		const longPrompt = "x".repeat(2000);
		const result = formatObservation(1, longPrompt, [], "ok");
		const userLine = result.split("\n").find((l) => l.startsWith("User:"));
		expect(userLine?.length).toBeLessThan(2000);
	});

	it("truncates long agent response to 2000 chars", () => {
		const longResponse = "y".repeat(3000);
		const result = formatObservation(1, "hi", [], longResponse);
		const agentLine = result.split("\n").find((l) => l.startsWith("Agent:"));
		expect(agentLine?.length).toBeLessThan(3000);
	});

	it("truncates long tool results to 500 chars", () => {
		const longResult = "z".repeat(1000);
		const result = formatObservation(1, "hi", [{ name: "bash", result: longResult }], "ok");
		const toolLine = result.split("\n").find((l) => l.includes("bash →"));
		expect(toolLine?.length).toBeLessThan(1000);
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

	it("query is string type", () => {
		expect(propHasType(SearchSchema, "query", "string")).toBeTrue();
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
});

describe("formatFrontmatter", () => {
	it("formats simple metadata", () => {
		
		const result = formatFrontmatter({ context: "test", type: "gotcha" });
		expect(result.startsWith("---\n")).toBeTrue();
		expect(result).toContain("context: test");
		expect(result).toContain("type: gotcha");
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
		expect(content).toContain("context: my-context");
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
		expect(supContent).toContain("superseded_at: 2025-01-15");
		expect(supContent).toContain("superseded_by: new-context");
		expect(supContent).toContain("confidence: 0");
		expect(supContent).toContain("## [2025-01-01] Old info");
	});
});

// ── Memory search ──────────────────────────────────────────────────────────

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
	});

	afterAll(async () => {
		const { MEMORIES_ROOT } = await import("../utils.ts");
		const testDir = join(MEMORIES_ROOT, "projects", testProjectId);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

		const globalFile = join(MEMORIES_ROOT, "_global", "_rules", "test-global.md");
		if (existsSync(globalFile)) rmSync(globalFile);
	});

	it("returns empty array for non-matching query", () => {
		const results = searchMemories({ query: "zzzxyznonexistent_12345", limit: 5 });
		expect(results).toEqual([]);
	});

	it("finds by keyword in all scopes", () => {
		const results = searchMemories({ query: "unicorns", limit: 10 });
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
		const results = searchMemories({ query: "unicorns", scope: "project", limit: 10 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		for (const r of results) {
			expect(r.file).toContain("projects");
		}
	});

	it("filters by type", () => {
		const results = searchMemories({ query: ".*", type: "gotchas", limit: 10 });
		for (const r of results) {
			expect(r.file).toContain("gotchas");
		}
	});

	it("filters by minConfidence", () => {
		const results = searchMemories({ query: "unicorns", minConfidence: 0.9, limit: 10 });
		// test memory has confidence 0.7, so should be filtered out
		const match = results.find((r) => r.file.includes("test-memory.md"));
		expect(match).toBeUndefined();
	});

	it("respects limit", () => {
		const results = searchMemories({ query: "test", limit: 1 });
		expect(results.length).toBeLessThanOrEqual(1);
	});

	it("excludes .supersedes/ files", () => {
		const results = searchMemories({ query: "old memory", limit: 10 });
		for (const r of results) {
			expect(r.file).not.toContain(".supersedes");
		}
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
		expect(content).toContain("context: decayme");
		expect(content).toContain("superseded_at:");
		expect(content).toContain("superseded_reason: test decay");
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
		expect(prompt).toContain("Same context = same file");
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
		expect(content).toContain("context: test-ctx");
		expect(content).toContain("## ");
		expect(content).toContain("Some rich content");
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
});
