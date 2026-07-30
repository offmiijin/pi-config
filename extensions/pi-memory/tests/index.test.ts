/**
 * Tests for pi-memory (Part 1: Scaffold).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
	ensureDirectories,
	generateSessionHash,
	getMemoryDirectories,
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
		// Cleanup test memory dirs we might have created
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
		// root + 5 global + 5 supersedes_global + 5 project + 1 sessions + 5 supersedes_project
		const dirs = getMemoryDirectories("test_project");
		expect(dirs).toHaveLength(1 + 5 + 5 + 5 + 1 + 5);
	});
});

// ── ensureDirectories ──────────────────────────────────────────────────────

describe("ensureDirectories", () => {
	const TEST_PROJECT = "ensure_test";

	afterAll(() => {
		// Cleanup created directories
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
