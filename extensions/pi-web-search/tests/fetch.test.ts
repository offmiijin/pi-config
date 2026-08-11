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
	readFile: vi.fn().mockResolvedValue("%PDF text extracted by mock"),
	rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock pdftotext (node:child_process) — pdftotext disponível, extração ok
vi.mock("node:child_process", () => {
	const { EventEmitter } = require("node:events");
	return {
		spawnSync: vi.fn(() => ({ error: undefined })),
		spawn: vi.fn(() => {
			const child = new EventEmitter() as any;
			child.kill = vi.fn();
			setImmediate(() => child.emit("close", 0));
			return child;
		}),
	};
});

// Mock randomDelay and randomUserAgent so tests run instantly and deterministically
vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		randomDelay: vi.fn().mockResolvedValue(undefined),
		randomUserAgent: vi.fn().mockReturnValue("TestAgent/1.0"),
	};
});

import {
	extractText,
	fetchPages,
	extensionForContentType,
	__resetPdfTextCache,
} from "../fetch";
import { spawnSync } from "node:child_process";

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

	it("outputDir is <cwd>/.sandbox-cache/fetch/page_<key>/", async () => {
		const output = await fetchPages(["https://example.com"], testCwd);
		expect(output.outputDir).toBe(
			`${testCwd}/.sandbox-cache/fetch/page_default`,
		);
	});

	it("uses session key to scope the output dir", async () => {
		const output = await fetchPages(
			["https://example.com"],
			testCwd,
			undefined,
			3,
			"sess-abc-123",
		);
		expect(output.outputDir).toBe(
			`${testCwd}/.sandbox-cache/fetch/page_sess-abc-123`,
		);
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

	it("downloads PDF as binary to the session dir", async () => {
		(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			status: 200,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "content-type" ? "application/pdf" : null,
			},
			text: async () => "%PDF-1.4...",
			arrayBuffer: async () =>
				new TextEncoder().encode("%PDF-1.4...").buffer,
		});

		const output = await fetchPages(["https://example.com/doc.pdf"], testCwd);
		expect(output.succeeded).toBe(1);
		expect(output.failed).toBe(0);
		const r = output.results[0];
		expect(r.error).toBeUndefined();
		expect(r.binary).toBe(true);
		expect(r.file).toBe("https_example_com_doc_pdf.pdf");
		expect(r.textFile).toBe("https_example_com_doc_pdf.txt");
		expect(r.size).toBeGreaterThan(0);
		expect(output.binaryDir).toBe(`${testCwd}/.sandbox-cache/fetch/page_default`);
	});

	it("sniffs PDF by magic bytes even with generic content-type", async () => {
		(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			status: 200,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "content-type" ? "application/octet-stream" : null,
			},
			text: async () => "%PDF-1.7 data",
			arrayBuffer: async () =>
				new TextEncoder().encode("%PDF-1.7 data").buffer,
		});

		const output = await fetchPages(["https://example.com/spec"], testCwd);
		const r = output.results[0];
		expect(r.binary).toBe(true);
		expect(r.file).toBe("https_example_com_spec.bin");
		expect(r.textFile).toBe("https_example_com_spec.txt");
	});

	it("notes when pdftotext is unavailable", async () => {
		__resetPdfTextCache();
		vi.mocked(spawnSync).mockReturnValueOnce({ error: new Error("ENOENT") } as any);

		(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			status: 200,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "content-type" ? "application/pdf" : null,
			},
			text: async () => "%PDF-1.4",
			arrayBuffer: async () =>
				new TextEncoder().encode("%PDF-1.4").buffer,
		});

		const output = await fetchPages(["https://example.com/doc.pdf"], testCwd);
		const r = output.results[0];
		expect(r.textFile).toBeUndefined();
		expect(r.note).toContain("pdftotext");

		__resetPdfTextCache();
	});

	it("falls back to .bin when content-type is unknown", async () => {
		(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			status: 200,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "content-type" ? "application/octet-stream" : null,
			},
			text: async () => "\u0000\u0001\u0002",
			arrayBuffer: async () =>
				new TextEncoder().encode("\u0000\u0001\u0002").buffer,
		});

		const output = await fetchPages(["https://example.com/blob"], testCwd);
		expect(output.succeeded).toBe(1);
		expect(output.results[0].file).toBe("https_example_com_blob.bin");
	});

	it("uses URL extension when content-type is absent", async () => {
		(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () => "data",
			arrayBuffer: async () => new TextEncoder().encode("data").buffer,
		});

		const output = await fetchPages(["https://example.com/file.zip"], testCwd);
		expect(output.results[0].file).toBe("https_example_com_file_zip.zip");
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

// ---------------------------------------------------------------------------
// extensionForContentType — pure function
// ---------------------------------------------------------------------------
describe("extensionForContentType", () => {
	it("maps known application types", () => {
		expect(extensionForContentType("application/pdf", "https://x/a")).toBe("pdf");
		expect(extensionForContentType("application/zip", "https://x/a")).toBe("zip");
		expect(
			extensionForContentType(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"https://x/a",
			),
		).toBe("docx");
	});

	it("maps image/audio/video subtypes", () => {
		expect(extensionForContentType("image/png", "https://x/a")).toBe("png");
		expect(extensionForContentType("image/jpeg", "https://x/a")).toBe("jpg");
		expect(extensionForContentType("image/svg+xml", "https://x/a")).toBe("svg");
		expect(extensionForContentType("video/mp4", "https://x/a")).toBe("mp4");
	});

	it("ignores charset suffix", () => {
		expect(extensionForContentType("text/html; charset=utf-8", "https://x/a")).toBe("bin");
	});

	it("falls back to URL extension then .bin", () => {
		expect(extensionForContentType("application/octet-stream", "https://x/file.tar.gz")).toBe("gz");
		expect(extensionForContentType("application/octet-stream", "https://x/blob")).toBe("bin");
		expect(extensionForContentType("", "https://x/blob")).toBe("bin");
	});
});
