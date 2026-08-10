/**
 * pi-memory — Tests: helpers de sessão vivos (hash, estimativa de tokens,
 * ensureFileDir). Os testes do pipeline antigo de observações markdown foram
 * removidos junto com o código morto.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	ensureFileDir,
	estimateTokens,
	generateSessionHash,
	hashSessionFile,
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
