/**
 * Web Search Extension — Page Fetcher
 *
 * Fetches pages in parallel (max 10 concurrent), extracts clean text with
 * cheerio, and saves everything (text + binary) under
 * <cwd>/.sandbox-cache/fetch/page_<sessionId>/ — ONE directory per pi session.
 *
 * Uses project-local cache so files are accessible inside dev-sandbox's bwrap
 * namespace (which mounts $CWD read-write but has isolated /tmp). The fetch root
 * is the same dir used by dev-sandbox's sandbox_fetch (QUARANTINE_DIR_DEFAULTS.fetch);
 * page dirs (page_*) live inside it and are cleaned after 7 days.
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
	/** true quando o conteúdo foi baixado como arquivo binário (não texto) */
	binary?: boolean;
}

export interface FetchOutput {
	outputDir: string;
	/** diretório dos arquivos binários (= outputDir) — presente quando houve download */
	binaryDir?: string;
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

function randomHex(length: number): string {
	return Math.random().toString(16).slice(2, 2 + length);
}

/** Sanitiza o id da sessão para uso como nome de diretório. */
function sanitizeSessionKey(key: string): string {
	const clean = key.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	return (clean || "default").slice(0, 64);
}

// ---------------------------------------------------------------------------
// Binary content
// ---------------------------------------------------------------------------

/**
 * Extensão de arquivo a partir do Content-Type.
 * Tipos conhecidos → mapa fixo; image/audio/video/font → subtipo;
 * senão extensão da URL; último recurso `.bin`.
 */
/** @visibleForTesting */
export function extensionForContentType(contentType: string, url: string): string {
	const ct = (contentType.split(";")[0] || "").trim().toLowerCase();

	const special: Record<string, string> = {
		"application/pdf": "pdf",
		"application/zip": "zip",
		"application/gzip": "gz",
		"application/x-tar": "tar",
		"application/x-7z-compressed": "7z",
		"application/x-rar-compressed": "rar",
		"application/msword": "doc",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"application/vnd.ms-excel": "xls",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"application/vnd.ms-powerpoint": "ppt",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
		"application/json": "json",
		"application/xml": "xml",
	};
	if (special[ct]) return special[ct];

	const [main, sub] = ct.split("/");
	if (main && sub && ["image", "audio", "video", "font"].includes(main)) {
		const s = sub.split("+")[0];
		return s === "jpeg" ? "jpg" : s || "bin";
	}

	// Fallback: extensão do caminho da URL
	try {
		const urlExt = path
			.extname(new URL(url).pathname)
			.replace(/^\./, "")
			.toLowerCase();
		if (urlExt && urlExt.length <= 10) return urlExt;
	} catch { /* URL inválida — usa .bin */ }
	return "bin";
}

/** Nome base sanitizado da URL, sem extensão. */
function urlToBaseName(url: string): string {
	return sanitizeFilename(url).replace(/\.txt$/, "");
}

/** Garante nome único: colisões ganham sufixo _2, _3... preservando a extensão. */
function uniqueFilename(filename: string, used: Set<string>): string {
	let f = filename;
	while (used.has(f)) {
		const dot = f.lastIndexOf(".");
		const base = dot > 0 ? f.slice(0, dot) : f;
		const ext = dot > 0 ? f.slice(dot) : "";
		const m = base.match(/_\d+$/);
		f = m
			? `${base.replace(/_\d+$/, "")}_${parseInt(m[0].slice(1)) + 1}${ext}`
			: `${base}_2${ext}`;
	}
	return f;
}


// ---------------------------------------------------------------------------
// Cache cleanup
// ---------------------------------------------------------------------------

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Remove page directories (page_*, um por sessão do pi) older than 7 days.
 * Only touches dirs with the page_ prefix — artifacts of sandbox_fetch
 * at the fetch root (files, ca-extract/, ...) are never removed.
 * Silently ignores errors (permission, race, etc.).
 */
async function cleanOldPages(baseDir: string): Promise<void> {
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
 *   <cwd>/.sandbox-cache/fetch/page_<sessionId>/<sanitised-url>.txt
 * Non-text responses (PDF, images, archives, ...) are downloaded as-is to:
 *   <cwd>/.sandbox-cache/fetch/page_<sessionId>/<sanitised-url>.<ext>
 *
 * `sessionKey` escopa a saída: um único diretório por sessão do pi (todas as
 * chamadas de web_fetch da mesma sessão compartilham o dir). Fallback: "default".
 *
 * Uses project-local .sandbox-cache/ so files are accessible inside dev-sandbox's
 * bwrap namespace (which mounts $CWD read-write but has isolated /tmp).
 */
export async function fetchPages(
	urls: string[],
	cwd: string,
	signal?: AbortSignal,
	maxConcurrent: number = DEFAULT_CONCURRENCY,
	sessionKey: string = "default",
): Promise<FetchOutput> {
	// 1. Clean pages older than 7 days, then resolve the session dir
	const fetchRoot = path.join(cwd, ".sandbox-cache", "fetch");
	await cleanOldPages(fetchRoot);
	// Um único dir por sessão — texto e binário juntos
	const sessionDir = path.join(fetchRoot, `page_${sanitizeSessionKey(sessionKey)}`);
	await fs.mkdir(sessionDir, { recursive: true });
	const outputDir = sessionDir;
	const binaryDir = sessionDir;

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

			// Only process HTML / plain text responses; everything else is
			// downloaded as-is to .sandbox-cache/fetch/ (PDF, imagens, ...)
			const contentType = (response.headers.get("content-type") || "").toLowerCase();
			const isText =
				contentType.includes("text/html") || contentType.includes("text/plain");

			let filename: string;
			if (isText) {
				const html = await response.text();
				const text = extractText(html);
				filename = uniqueFilename(`${urlToBaseName(url)}.txt`, usedFilenames);
				const filePath = path.join(outputDir, filename);
				await fs.writeFile(filePath, text, "utf-8");

				results.push({
					url,
					file: filename,
					size: Buffer.byteLength(text, "utf-8"),
					status: response.status,
				});
			} else {
				// Download binário: preserva bytes originais
				const ext = extensionForContentType(contentType, url);
				filename = uniqueFilename(`${urlToBaseName(url)}.${ext}`, usedFilenames);
				const buf = Buffer.from(await response.arrayBuffer());
				const filePath = path.join(binaryDir, filename);
				await fs.writeFile(filePath, buf);

				results.push({
					url,
					file: filename,
					size: buf.byteLength,
					status: response.status,
					binary: true,
				});
			}
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

	const hasBinary = results.some((r) => r.binary);
	return {
		outputDir,
		binaryDir: hasBinary ? binaryDir : undefined,
		total: urls.length,
		succeeded,
		failed,
		results,
	};
}
