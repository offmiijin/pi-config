/**
 * Tests for pi-memory (Part 1 + 2: Scaffold + Observations).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
	countObservations,
	ensureDirectories,
	ensureFileDir,
	extractTextContent,
	extractToolCallNames,
	formatObservation,
	formatSessionHeader,
	formatTimestamp,
	generateSessionHash,
	getMemoryDirectories,
	getSessionFilePath,
	hashSessionFile,
	identifyProject,
	MEMORIES_ROOT,
	MEMORY_TYPES,
} from "../utils.ts";

// ── identifyProject ────────────────────────────────────────────────────────

describe("identifyProject", () => {
	let tmpDir: string;

	beforeAll(() => {
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
		const content = [{ type: "toolCall", arguments: {} }, { type: "toolCall", name: "rg", arguments: {} }];
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
	it("produces correct structure with all fields", () => {
		const result = formatObservation(1, "Create login", ["read", "edit"], "Added form", new Date(2025, 0, 15, 10, 30, 0));

		const lines = result.split("\n");
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("## Obs #1 (10:30:00)");
		expect(lines[2]).toBe('User: "Create login"');
		expect(lines[3]).toBe("Tools: read, edit");
		expect(lines[4]).toBe('Agent: "Added form"');
	});

	it("shows (none) when no tools called", () => {
		const result = formatObservation(2, "Hello", [], "Hi", new Date(2025, 0, 15, 10, 0, 0));
		expect(result).toContain("Tools: (none)");
	});

	it("shows (no response) when agent response is empty", () => {
		const result = formatObservation(3, "Test", ["bash"], "", new Date(2025, 0, 15, 10, 0, 0));
		expect(result).toContain("Agent: (no response)");
	});

	it("truncates long user prompt to 1000 chars", () => {
		const longPrompt = "x".repeat(2000);
		const result = formatObservation(1, longPrompt, [], "ok");
		// The user prompt in the output should be truncated
		const userLine = result.split("\n").find((l) => l.startsWith('User:'));
		expect(userLine?.length).toBeLessThan(2000);
	});

	it("truncates long agent response to 2000 chars", () => {
		const longResponse = "y".repeat(3000);
		const result = formatObservation(1, "hi", [], longResponse);
		const agentLine = result.split("\n").find((l) => l.startsWith('Agent:'));
		expect(agentLine?.length).toBeLessThan(3000);
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

	beforeAll(() => {
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

	beforeAll(() => {
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
		ensureFileDir(nested); // second call should not throw
		expect(existsSync(join(tmpDir, "exists"))).toBeTrue();
	});
});
