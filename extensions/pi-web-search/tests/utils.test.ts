/**
 * Tests for utils.ts
 *
 * Covers: sanitizeFilename, randomUserAgent, asyncPool
 */

import { describe, it, expect } from "vitest";
import {
	sanitizeFilename,
	randomUserAgent,
	USER_AGENTS,
	asyncPool,
} from "../utils";

// sanitizeFilename
describe("sanitizeFilename", () => {
	it("converts standard URL with path", () => {
		expect(sanitizeFilename("https://example.com/page")).toBe(
			"https_example_com_page.txt",
		);
	});

	it("handles URL with query parameters", () => {
		expect(
			sanitizeFilename("https://example.com/page?id=123&name=test"),
		).toMatch(/^https_example_com_page_id_123_name_test\.txt$/);
	});

	it("replaces special characters with underscores", () => {
		const result = sanitizeFilename("https://site.com/a?b=c#d");
		// All special chars replaced by _
		expect(result).not.toContain("?");
		expect(result).not.toContain("=");
		expect(result).not.toContain("#");
		expect(result).toMatch(/\.txt$/);
	});

	it("collapses multiple underscores", () => {
		const result = sanitizeFilename("https://a..b/?c=d&e=f");
		expect(result).not.toContain("__");
	});

	it("handles empty URL", () => {
		expect(sanitizeFilename("")).toBe(".txt");
	});

	it("truncates long URLs", () => {
		const longPath = "a".repeat(500);
		const result = sanitizeFilename(`https://example.com/${longPath}`);
		// Name component (without .txt) should be ≤ 200
		expect(result.length - 4).toBeLessThanOrEqual(200);
		expect(result).toMatch(/\.txt$/);
	});

	it("lowercases the result", () => {
		const result = sanitizeFilename("HTTPS://EXAMPLE.COM/PAGE");
		expect(result).toBe(result.toLowerCase());
	});

	it("removes leading and trailing underscores", () => {
		const result = sanitizeFilename("https:///page");
		expect(result.startsWith("_")).toBe(false);
		expect(result.endsWith("_")).toBe(false);
	});

	it("works with http (not just https)", () => {
		expect(sanitizeFilename("http://example.com")).toBe(
			"http_example_com.txt",
		);
	});
});

// randomUserAgent
describe("randomUserAgent", () => {
	it("returns a string from the USER_AGENTS pool", () => {
		const ua = randomUserAgent();
		expect(USER_AGENTS).toContain(ua);
	});

	it("returns different values over multiple calls (probabilistic)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			seen.add(randomUserAgent());
		}
		// With 8 agents in the pool, 100 random picks should hit several
		expect(seen.size).toBeGreaterThan(1);
	});

	it("always returns a non-empty string", () => {
		for (let i = 0; i < 50; i++) {
			expect(randomUserAgent().length).toBeGreaterThan(0);
		}
	});
});

// asyncPool
describe("asyncPool", () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const processed: number[] = [];

		await asyncPool(2, items, async (item) => {
			processed.push(item);
		});

		expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it("limits concurrency", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;

		await asyncPool(2, [1, 2, 3, 4, 5], async (_item) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			// Simulate async work
			await new Promise((r) => setTimeout(r, 20));
			concurrent--;
		});

		expect(maxConcurrent).toBeLessThanOrEqual(2);
		// Concurrency should have reached 2 at some point
		expect(maxConcurrent).toBe(2);
	});

	it("handles empty array", async () => {
		await expect(asyncPool(10, [], async () => {})).resolves.toBeUndefined();
	});

	it("handles single item", async () => {
		const processed: number[] = [];
		await asyncPool(5, [42], async (item) => {
			processed.push(item);
		});
		expect(processed).toEqual([42]);
	});

	it("concurrency larger than items does not cause issues", async () => {
		const processed: number[] = [];
		await asyncPool(100, [1, 2, 3], async (item) => {
			processed.push(item);
		});
		expect(processed.sort()).toEqual([1, 2, 3]);
	});

	it("rejection in one item does not stop others", async () => {
		const processed: number[] = [];

		// Error is collected, all items still run, then error is re-thrown
		await expect(
			asyncPool(2, [1, 2, 3], async (item) => {
				processed.push(item);
				if (item === 2) throw new Error("boom");
				await new Promise((r) => setTimeout(r, 5));
			}),
		).rejects.toThrow("boom");

		// All items processed even though one failed
		expect(processed.sort()).toEqual([1, 2, 3]);
	});

	it("handles concurrency of 1 (sequential)", async () => {
		const order: number[] = [];

		await asyncPool(1, [1, 2, 3], async (item) => {
			await new Promise((r) => setTimeout(r, 5));
			order.push(item);
		});

		expect(order).toEqual([1, 2, 3]);
	});
});
