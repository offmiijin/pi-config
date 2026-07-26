/**
 * Web Search Extension — Page Fetcher
 *
 * Fetches pages in parallel (max 10 concurrent), extracts clean text with
 * cheerio, and saves each page to <cwd>/.sandbox-cache/web-fetch/page_<date>_<randomhex>/.
 *
 * Uses project-local cache so files are accessible inside dev-sandbox's bwrap
 * namespace (which mounts $CWD read-write but has isolated /tmp).
 */

import * as cheerio from "cheerio";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	randomUserAgent,
	randomDelay,
	asyncPool,
	sanitizeFilename,
	FETCH_TIMEOUT_MS,
	DEFAULT_CONCURRENCY,
} from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface FetchItemResult {
	url: string;
	file?: string;
	size?: number;
	status?: number;
	error?: string;
}

export interface FetchOutput {
	outputDir: string;
	total: number;
	succeeded: number;
	failed: number;
	results: FetchItemResult[];
}

// ---------------------------------------------------------------------------
// HTML → clean text
// ---------------------------------------------------------------------------

/**
 * Strip all tags, scripts, styles, navigation elements from HTML.
 * Returns plain text with normalised whitespace.
 */
/** @visibleForTesting */
export function extractText(html: string): string {
	const $ = cheerio.load(html);

	// Remove non-content elements
	$(
		"script, style, noscript, svg, iframe, " +
			"nav, footer, header, " +
			'[role="navigation"], [role="banner"], [role="contentinfo"]',
	).remove();

	const body = $("body").length ? $("body") : $.root();
	let text = body.text();

	// Normalise whitespace
	text = text.replace(/\s+/g, " ").trim();

	return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDateStr(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}${m}${d}`;
}

function randomHex(length: number): string {
	return Math.random().toString(16).slice(2, 2 + length);
}


// ---------------------------------------------------------------------------
// Cache cleanup
// ---------------------------------------------------------------------------

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Remove cache directories older than 7 days.
 * Silently ignores errors (permission, race, etc.).
 */
async function cleanOldCaches(baseDir: string): Promise<void> {
	const now = Date.now();
	try {
		const entries = await fs.readdir(baseDir, { withFileTypes: true });
		await Promise.all(entries.map(async (entry) => {
			if (!entry.isDirectory()) return;
			if (!entry.name.startsWith("page_")) return;
			const fullPath = path.join(baseDir, entry.name);
			try {
				const stat = await fs.stat(fullPath);
				if (now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
					await fs.rm(fullPath, { recursive: true, force: true });
				}
			} catch { /* ignorar */ }
		}));
	} catch { /* baseDir ainda nao existe -- ok */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all `urls` concurrently (max `maxConcurrent` at a time).
 *
 * Each request:
 *   - picks a random User-Agent from the pool
 *   - waits a random 500–2000ms delay before starting
 *   - aborts after FETCH_TIMEOUT_MS (15s)
 *   - respects the external `signal` for Esc-based abort
 *
 * Successful pages are saved as clean text to:
 *   <cwd>/.sandbox-cache/web-fetch/page_<YYYYMMDD>_<8-char-hex>/<sanitised-url>.txt
 *
 * Uses project-local .sandbox-cache/ so files are accessible inside dev-sandbox's
 * bwrap namespace (which mounts $CWD read-write but has isolated /tmp).
 */
export async function fetchPages(
	urls: string[],
	cwd: string,
	signal?: AbortSignal,
	maxConcurrent: number = DEFAULT_CONCURRENCY,
): Promise<FetchOutput> {
	// 1. Clean caches older than 7 days, then create fresh output directory
	const dateStr = getDateStr();
	const randHex = randomHex(8);
	const cacheRoot = path.join(cwd, ".sandbox-cache", "web-fetch");
	await cleanOldCaches(cacheRoot);
	const outputDir = path.join(cacheRoot, `page_${dateStr}_${randHex}`);
	await fs.mkdir(outputDir, { recursive: true });

	const results: FetchItemResult[] = [];
	const usedFilenames = new Set<string>();

	// 2. Process URLs with bounded concurrency
	await asyncPool(maxConcurrent, urls, async (url) => {
		// Honour external abort (Esc)
		if (signal?.aborted) return;

		// ── Throttle ────────────────────────────────────────────────
		await randomDelay();

		// ── Prepare request ─────────────────────────────────────────
		const ua = randomUserAgent();

		// Build a per-request abort controller wired to the external signal
		const controller = new AbortController();
		const abortHandler = () => controller.abort(signal?.reason);
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		const timer = setTimeout(
			() => controller.abort(new Error("TIMEOUT")),
			FETCH_TIMEOUT_MS,
		);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent": ua,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
				},
			});

			// Check HTTP status
			if (!response.ok) {
				results.push({
					url,
					error: `HTTP ${response.status} ${response.statusText}`,
					status: response.status,
				});
				return;
			}

			// Only process HTML / plain text responses
			const contentType = (response.headers.get("content-type") || "").toLowerCase();
			if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
				results.push({
					url,
					error: `UNSUPPORTED: ${contentType}`,
					status: response.status,
				});
				return;
			}

			const html = await response.text();
			const text = extractText(html);

			// ── Save to file ────────────────────────────────────────
			// Collision-safe filename: if two URLs sanitise to the same
			// name, the second gets a `_2` suffix.
			let filename = sanitizeFilename(url);
			while (usedFilenames.has(filename)) {
				const base = filename.replace(/\.txt$/, "");
				const match = base.match(/_(\d+)$/);
				if (match) {
					filename = `${base.replace(/_\d+$/, "")}_${parseInt(match[1]) + 1}.txt`;
				} else {
					filename = `${base}_2.txt`;
				}
			}
			usedFilenames.add(filename);

			const filePath = path.join(outputDir, filename);
			await fs.writeFile(filePath, text, "utf-8");

			results.push({
				url,
				file: filename,
				size: Buffer.byteLength(text, "utf-8"),
				status: response.status,
			});
		} catch (err: unknown) {
			const name = err instanceof Error ? err.name : "";
			const message = err instanceof Error ? err.message : String(err);

			if (name === "AbortError") {
				results.push({ url, error: "ABORTED" });
			} else {
				results.push({ url, error: message || name || "UNKNOWN" });
			}
		} finally {
			clearTimeout(timer);
			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		}
	});

	// 3. Tally results
	const succeeded = results.filter((r) => !r.error).length;
	const failed = results.filter((r) => r.error).length;

	return { outputDir, total: urls.length, succeeded, failed, results };
}
