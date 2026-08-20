/**
 * Web Search Extension — Utilities
 *
 * UA pool, random delay, filename sanitization, async concurrency pool.
 */

// User-Agent Pool — 8 realistas de navegadores modernos
export const USER_AGENTS = [
	// Chrome 135 — Windows
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
	// Chrome 135 — macOS
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
	// Chrome 135 — Linux
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
	// Firefox 140 — Windows
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
	// Firefox 140 — macOS
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
	// Firefox 140 — Linux
	"Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
	// Safari 19.0 — macOS
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
	// Edge 135 — Windows
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
];

/** Pick a random User-Agent from the pool */
export function randomUserAgent(): string {
	return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Delay
export const MIN_DELAY_MS = 1500;
export const MAX_DELAY_MS = 3000;
export const MIN_SEARCH_INTERVAL_MS = 2000;

/** Wait between `min` and `max` milliseconds (defaults to 500-2000) */
export function randomDelay(min = MIN_DELAY_MS, max = MAX_DELAY_MS): Promise<void> {
	const ms = Math.floor(Math.random() * (max - min + 1)) + min;
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Search throttle — minimum spacing between searches

let lastSearchTime = 0;

/**
 * Ensures a minimum interval between consecutive search requests.
 * Calls queued closer together than `MIN_SEARCH_INTERVAL_MS` are
 * delayed so they don't hit DuckDuckGo simultaneously.
 */
export async function throttleSearch(): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastSearchTime;
	if (elapsed < MIN_SEARCH_INTERVAL_MS) {
		await new Promise((r) => setTimeout(r, MIN_SEARCH_INTERVAL_MS - elapsed));
	}
	lastSearchTime = Date.now();
}

// Timeouts
export const SEARCH_TIMEOUT_MS = 10_000;
export const FETCH_TIMEOUT_MS = 15_000;
/** Orçamento estendido para download de binários (PDFs grandes, servidores lentos). */
export const BINARY_TIMEOUT_MS = 60_000;
export const DEFAULT_CONCURRENCY = 3;

// Filename sanitization
/**
 * Convert a URL to a safe filename.
 *
 * Example:
 *   https://example.com/page?id=123  →  https_example_com_page_id_123.txt
 */
export function sanitizeFilename(url: string): string {
	let name = url
		.replace(/^https?:\/\//i, (m) => m.replace(":", "_").replace("//", "_"))
		// 1) "https://" or "http://" → "https_" / "http_"
		.replace(/[\/?=&#.:;@+$~%,|!()'*\[\]]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.toLowerCase();

	// Truncate to 200 chars to avoid filesystem limits
	if (name.length > 200) {
		name = name.slice(0, 200);
	}

	return `${name}.txt`;
}

// Async concurrency pool
/**
 * Process an array of items with limited concurrency.
 *
 * Each item is processed by `fn`. At most `concurrency` promises run in
 * parallel; remaining items queue and start as slots free up.
 */
export async function asyncPool<T>(
	concurrency: number,
	items: T[],
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const executing = new Set<Promise<void>>();
	let firstError: unknown = undefined;

	for (const item of items) {
		// Catch per-item errors so the loop continues processing remaining items
		const p = fn(item).catch((e) => {
			if (firstError === undefined) firstError = e;
		});
		executing.add(p);
		p.finally(() => executing.delete(p));

		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}

	await Promise.all(executing);

	// Re-throw the first error after all items have been processed
	if (firstError !== undefined) throw firstError;
}
