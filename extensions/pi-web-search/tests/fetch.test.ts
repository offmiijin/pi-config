/**
 * Tests for fetch.ts
 *
 * Covers: extractText (pure function), fetchPages (mocked fetch + fs + utils)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock filesystem — no real I/O during tests
vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock randomDelay and randomUserAgent so tests run instantly and deterministically
vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		randomDelay: vi.fn().mockResolvedValue(undefined),
		randomUserAgent: vi.fn().mockReturnValue("TestAgent/1.0"),
	};
});

import { extractText, fetchPages } from "../fetch";

// Test cwd — used for all fetchPages calls
const testCwd = "/home/user/project";

// ---------------------------------------------------------------------------
// extractText — pure function, no mocking needed
// ---------------------------------------------------------------------------
describe("extractText", () => {
	it("extracts text from simple HTML", () => {
		const html = "<html><body><p>Hello World</p></body></html>";
		expect(extractText(html)).toBe("Hello World");
	});

	it("strips <script> tags and their content", () => {
		const html = `<html><body>
			<p>Visible</p>
			<script>alert("hidden")</script>
			<p>Also visible</p>
		</body></html>`;
		const text = extractText(html);
		expect(text).toContain("Visible");
		expect(text).toContain("Also visible");
		expect(text).not.toContain("hidden");
	});

	it("strips <style> tags and their content", () => {
		const html = `<html><body>
			<p>Text</p>
			<style>.c{color:red}</style>
		</body></html>`;
		const text = extractText(html);
		expect(text).toBe("Text");
	});

	it("removes <nav>, <footer>, <header> elements", () => {
		const html = `<html><body>
			<header>Header</header>
			<nav>Navigation</nav>
			<main><p>Main content</p></main>
			<footer>Footer</footer>
		</body></html>`;
		const text = extractText(html);
		expect(text).toContain("Main content");
		expect(text).not.toContain("Header");
		expect(text).not.toContain("Navigation");
		expect(text).not.toContain("Footer");
	});

	it("removes elements with navigation/banner ARIA roles", () => {
		const html = `<html><body>
			<div role="navigation">Menu</div>
			<div role="banner">Banner</div>
			<div role="contentinfo">Info</div>
			<p>Real content</p>
		</body></html>`;
		const text = extractText(html);
		expect(text).toContain("Real content");
		expect(text).not.toContain("Menu");
		expect(text).not.toContain("Banner");
		expect(text).not.toContain("Info");
	});

	it("normalises excessive whitespace", () => {
		const html = `<html><body>
			<p>  Line 1  </p>
			<p>  Line 2  </p>
			<div>    Tabs\t\there    </div>
		</body></html>`;
		const text = extractText(html);
		expect(text).toMatch(/^Line 1 Line 2 Tabs here$/);
	});

	it("returns empty string for empty input", () => {
		expect(extractText("")).toBe("");
	});

	it("returns empty string for HTML with only removed elements", () => {
		const html = "<html><body><script>x</script><style>y</style></body></html>";
		expect(extractText(html)).toBe("");
	});

	it("handles fragment without <body> gracefully", () => {
		expect(extractText("<p>Just a fragment</p>")).toBe("Just a fragment");
	});

	it("strips <noscript> and <svg> elements", () => {
		const html = `<html><body>
			<noscript>JS required</noscript>
			<svg><text>SVG text</text></svg>
			<p>Real</p>
		</body></html>`;
		const text = extractText(html);
		expect(text).toBe("Real");
	});

	it("strips <iframe> elements", () => {
		const html = `<html><body>
			<iframe src="https://other.com"></iframe>
			<p>Content</p>
		</body></html>`;
		const text = extractText(html);
		expect(text).toBe("Content");
	});
});

// ---------------------------------------------------------------------------
// fetchPages — mocked fetch + fs
// ---------------------------------------------------------------------------
describe("fetchPages", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: {
					get: (name: string) =>
						name.toLowerCase() === "content-type" ? "text/html" : null,
				},
				text: async () => "<html><body><p>Hello World</p></body></html>",
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns correct output structure", async () => {
		const output = await fetchPages(["https://example.com"], testCwd);

		expect(output).toHaveProperty("outputDir");
		expect(output).toHaveProperty("total", 1);
		expect(output).toHaveProperty("succeeded", 1);
		expect(output).toHaveProperty("failed", 0);
		expect(output.results).toHaveLength(1);
	});

	it("outputDir is under <cwd>/.sandbox-cache/web-fetch/ with date+hex subdir", async () => {
		const output = await fetchPages(["https://example.com"], testCwd);
		const expectedPrefix = `${testCwd}/.sandbox-cache/web-fetch/page_`;
		expect(output.outputDir.startsWith(expectedPrefix)).toBe(true);
		// Suffix: YYYYMMDD_XXXXXXXX (8-digit date + underscore + 8-char hex)
		expect(output.outputDir.slice(expectedPrefix.length)).toMatch(/^\d{8}_[0-9a-f]{8}$/);
	});

	it("processes multiple URLs", async () => {
		const urls = [
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
		];
		const output = await fetchPages(urls, testCwd);
		expect(output.total).toBe(3);
		expect(output.succeeded).toBe(3);
		expect(output.results).toHaveLength(3);
	});

	it("reports HTTP errors without crashing", async () => {
		(globalThis.fetch as any).mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			headers: { get: () => "text/html" },
			text: async () => "",
		});

		const output = await fetchPages(["https://example.com/404"], testCwd);
		expect(output.total).toBe(1);
		expect(output.succeeded).toBe(0);
		expect(output.failed).toBe(1);
		expect(output.results[0].error).toContain("404");
	});

	it("reports network errors without crashing", async () => {
		(globalThis.fetch as any).mockRejectedValue(new Error("ENOTFOUND"));

		const output = await fetchPages(["https://invalid.example.com"], testCwd);
		expect(output.total).toBe(1);
		expect(output.failed).toBe(1);
		expect(output.results[0].error).toBe("ENOTFOUND");
	});

	it("skips non-HTML content types", async () => {
		(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			status: 200,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "content-type" ? "application/pdf" : null,
			},
			text: async () => "%PDF-1.4...",
		});

		const output = await fetchPages(["https://example.com/doc.pdf"], testCwd);
		expect(output.succeeded).toBe(0);
		expect(output.failed).toBe(1);
		expect(output.results[0].error).toContain("UNSUPPORTED");
	});

	it("handles empty URL list", async () => {
		const output = await fetchPages([], testCwd);
		expect(output.total).toBe(0);
		expect(output.succeeded).toBe(0);
		expect(output.failed).toBe(0);
		expect(output.results).toEqual([]);
	});

	it("includes file path and size for successful pages", async () => {
		const output = await fetchPages(["https://example.com/page"], testCwd);
		const r = output.results[0];
		expect(r.file).toBe("https_example_com_page.txt");
		expect(r.size).toBeGreaterThan(0);
		expect(r.status).toBe(200);
	});

	it("handles mixture of success and failure", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: { get: () => "text/html" },
				text: async () => "<html><body><p>OK</p></body></html>",
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
				headers: { get: () => "text/html" },
				text: async () => "",
			});
		vi.stubGlobal("fetch", mockFetch);

		const output = await fetchPages([
			"https://example.com/ok",
			"https://example.com/fail",
		], testCwd);
		expect(output.succeeded).toBe(1);
		expect(output.failed).toBe(1);
	});
});
