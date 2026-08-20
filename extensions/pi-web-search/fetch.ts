/**
 * Web Search Extension — Page Fetcher
 *
 * Fetches pages in parallel (max 10 concurrent), converts HTML pages to
 * Markdown (.md) via html-to-markdown/, and saves everything (text + binary) under
 * <cwd>/.sandbox-cache/fetch/page_<sessionId>/ — ONE directory per pi session.
 * PDFs additionally get text extracted via `pdftotext` (poppler-utils) so the
 * agent can read the content (saved as <name>.txt beside the .pdf).
 *
 * Uses project-local cache so files are accessible inside pi-sandbox's bwrap
 * namespace (which mounts $CWD read-write but has isolated /tmp). The fetch root
 * is the same dir used by pi-sandbox's sandbox_fetch (QUARANTINE_DIR_DEFAULTS.fetch).
 */

import { htmlToMarkdown } from "./html-to-markdown";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
	randomUserAgent,
	randomDelay,
	asyncPool,
	sanitizeFilename,
	FETCH_TIMEOUT_MS,
	BINARY_TIMEOUT_MS,
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
	/** texto extraído do binário (PDF → pdftotext) salvo ao lado do arquivo */
	textFile?: string;
	/** aviso não-fatal (ex.: extração indisponível) */
	note?: string;
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
	return sanitizeFilename(url).replace(/\.(txt|md)$/, "");
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
// PDF text extraction (pdftotext / poppler-utils)
// ---------------------------------------------------------------------------

const PDF_TEXT_TIMEOUT_MS = 30_000;

let pdftotextAvailable: boolean | null = null;

/** pdftotext presente no PATH? (cache por processo) */
function isPdftotextAvailable(): boolean {
	if (pdftotextAvailable === null) {
		try {
			pdftotextAvailable = spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).error === undefined;
		} catch {
			pdftotextAvailable = false;
		}
	}
	return pdftotextAvailable;
}

/** @visibleForTesting */
export function __resetPdfTextCache(): void {
	pdftotextAvailable = null;
}

/**
 * Extrai texto do PDF via `pdftotext -layout` (poppler-utils).
 * Escreve o texto em `txtPath` e o retorna; null em falha/timeout/escaneado.
 */
async function extractPdfText(pdfPath: string, txtPath: string): Promise<string | null> {
	return new Promise((resolve) => {
		const child = spawn(
			"pdftotext",
			["-layout", "-enc", "UTF-8", pdfPath, txtPath],
			{ stdio: "ignore" },
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), PDF_TEXT_TIMEOUT_MS);
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.on("close", async (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				resolve(null);
				return;
			}
			try {
				resolve(await fs.readFile(txtPath, "utf-8"));
			} catch {
				resolve(null);
			}
		});
	});
}

/** true quando o buffer começa com magic bytes de PDF. */
function isPdfBuffer(buf: Buffer): boolean {
	return buf.subarray(0, 5).toString("latin1") === "%PDF-";
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
 * Successful pages are converted to Markdown and saved to:
 *   <cwd>/.sandbox-cache/fetch/page_<sessionId>/<sanitised-url>.md
 * Non-text responses (PDF, images, archives, ...) are downloaded as-is to:
 *   <cwd>/.sandbox-cache/fetch/page_<sessionId>/<sanitised-url>.<ext>
 *
 * `sessionKey` escopa a saída: um único diretório por sessão do pi (todas as
 * chamadas de web_fetch da mesma sessão compartilham o dir). Fallback: "default".
 *
 * Uses project-local .sandbox-cache/ so files are accessible inside pi-sandbox's
 * bwrap namespace (which mounts $CWD read-write but has isolated /tmp).
 */
export async function fetchPages(
	urls: string[],
	cwd: string,
	signal?: AbortSignal,
	maxConcurrent: number = DEFAULT_CONCURRENCY,
	sessionKey: string = "default",
): Promise<FetchOutput> {
	// Um único dir por sessão — texto e binário juntos
	const fetchRoot = path.join(cwd, ".sandbox-cache", "fetch");
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

		let timeoutId = setTimeout(
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

			// Binários podem ser grandes/lentos (PDF de MBs, servidores lentos):
			// estende o orçamento de download após o TTFB (headers recebidos).
			if (!isText) {
				clearTimeout(timeoutId);
				timeoutId = setTimeout(
					() => controller.abort(new Error("TIMEOUT")),
					BINARY_TIMEOUT_MS,
				);
			}

			let filename: string;
			if (isText) {
				// HTML → Markdown (.md) via html-to-markdown (baseUrl = URL final,
				// após redirects, para resolver links relativos nas fases seguintes)
				const html = await response.text();
				const { markdown } = htmlToMarkdown(html, {
					baseUrl: response.url || url,
				});
				filename = uniqueFilename(`${urlToBaseName(url)}.md`, usedFilenames);
				usedFilenames.add(filename);
				const filePath = path.join(outputDir, filename);
				await fs.writeFile(filePath, markdown, "utf-8");

				results.push({
					url,
					file: filename,
					size: Buffer.byteLength(markdown, "utf-8"),
					status: response.status,
				});
			} else {
				// Download binário: preserva bytes originais
				const buf = Buffer.from(await response.arrayBuffer());
				const ext = extensionForContentType(contentType, url);
				const isPdf = ext === "pdf" || isPdfBuffer(buf);
				filename = uniqueFilename(`${urlToBaseName(url)}.${ext}`, usedFilenames);
				usedFilenames.add(filename);
				const filePath = path.join(binaryDir, filename);
				await fs.writeFile(filePath, buf);

				const item: FetchItemResult = {
					url,
					file: filename,
					size: buf.byteLength,
					status: response.status,
					binary: true,
				};

				// PDF → extrai texto via pdftotext para o agente poder ler
				if (isPdf && isPdftotextAvailable()) {
					const textFile = uniqueFilename(`${urlToBaseName(url)}.txt`, usedFilenames);
					usedFilenames.add(textFile);
					const textPath = path.join(binaryDir, textFile);
					const text = await extractPdfText(filePath, textPath);
					if (text !== null && text.trim().length > 0) {
						await fs.writeFile(textPath, text, "utf-8");
						item.textFile = textFile;
					} else {
						// Escaneado/falha — remove arquivo de texto vazio, se criado
						await fs.rm(textPath, { force: true }).catch(() => undefined);
					}
				} else if (isPdf) {
					item.note = "pdftotext indisponível — texto do PDF não extraído (instale poppler-utils)";
				}

				results.push(item);
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
			clearTimeout(timeoutId);
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
