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
import {
	randomUserAgent,
	randomDelay,
	asyncPool,
	sanitizeFilename,
	FETCH_TIMEOUT_MS,
	BINARY_TIMEOUT_MS,
	DEFAULT_CONCURRENCY,
} from "./utils";
import { getRendererMode } from "./config";
import { isRendererInstallationInProgress } from "./renderer-install";
import { getSharedRendererClient } from "./renderer-client";
import { assertPublicUrl, fetchWithSafeRedirects } from "./url-safety";
import {
	extractPdfText,
	isPdftotextAvailable,
	resetPdftotextAvailability,
	hasSufficientText,
	isImageFile,
	ocrPdf,
	recognizeImage,
} from "../pi-document";

// Types
export interface FetchItemResult {
	url: string;
	file?: string;
	size?: number;
	status?: number;
	error?: string;
	/** true quando o conteúdo foi baixado como arquivo binário (não texto) */
	binary?: boolean;
	/** texto extraído do binário salvo ao lado do arquivo */
	textFile?: string;
	/** origem do texto extraído */
	textSource?: "pdftotext" | "ocr";
	/** aviso não-fatal (ex.: extração indisponível) */
	note?: string;
	/** true quando o HTML foi obtido após executar JavaScript */
	rendered?: boolean;
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

// Helpers

function randomHex(length: number): string {
	return Math.random().toString(16).slice(2, 2 + length);
}

/** Sanitiza o id da sessão para uso como nome de diretório. */
function sanitizeSessionKey(key: string): string {
	const clean = key.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	return (clean || "default").slice(0, 64);
}

// Binary content

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


// PDF text extraction is provided by @pi/document. The web-search extension
// only decides when to invoke it and persists the resulting text file.

/** @visibleForTesting */
export function __resetPdfTextCache(): void {
	resetPdftotextAvailability();
}

/** true quando o buffer começa com magic bytes de PDF. */
function isPdfBuffer(buf: Buffer): boolean {
	return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

// JavaScript rendering

/** Detecta um shell de SPA sem penalizar páginas HTML com conteúdo normal. */
function isLikelySpaShell(html: string, markdown: string): boolean {
	const meaningfulText = markdown.replace(/[`#*_>\[\]()\-]/g, "").replace(/\s/g, "");
	if (meaningfulText.length >= 200) return false;

	const frameworkMarker =
		/(id=["'](?:root|app|__next|app-root)["']|__next|__nuxt|ng-version|webpackJsonp|vite)/i;
	const scriptCount = (html.match(/<script\b/gi) || []).length;
	return frameworkMarker.test(html) || scriptCount >= 3;
}

// Public API

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

		// web_fetch roda fora do namespace do sandbox; valide antes de qualquer
		// requisição para evitar SSRF contra serviços locais ou endpoints internos.
		try {
			assertPublicUrl(url);
		} catch (error) {
			results.push({ url, error: `URL bloqueada: ${error instanceof Error ? error.message : 'URL inválida'}` });
			return;
		}

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
			const response = await fetchWithSafeRedirects(url, {
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
				// após redirects, para resolver links relativos no conteúdo convertido)
				let html = await response.text();
				let baseUrl = response.url || url;
				let status = response.status;
				let { markdown } = htmlToMarkdown(html, { baseUrl });
				let rendered = false;
				let note: string | undefined;
				const rendererMode = getRendererMode();
				const rendererInstalling = isRendererInstallationInProgress();
				const shouldRender =
					!rendererInstalling &&
					rendererMode !== "never" &&
					(rendererMode === "required" || isLikelySpaShell(html, markdown));

				if (rendererInstalling && rendererMode !== "never") {
					if (rendererMode === "required") {
						results.push({ url, error: "Renderer obrigatório: instalação em andamento" });
						return;
					}
					note = "renderer em instalação; conteúdo estático utilizado";
				}

				if (shouldRender) {
					try {
						const renderedPage = await getSharedRendererClient().render(
							baseUrl,
							signal,
						);
						html = renderedPage.html;
						baseUrl = renderedPage.finalUrl || baseUrl;
						status = renderedPage.status ?? status;
						({ markdown } = htmlToMarkdown(html, { baseUrl }));
						rendered = true;
						note = "conteúdo renderizado com Playwright";
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (rendererMode === "required") {
							results.push({ url, error: `Renderer obrigatório: ${message}` });
							return;
						}
						note = `renderer indisponível: ${message}`;
					}
				}

				filename = uniqueFilename(`${urlToBaseName(url)}.md`, usedFilenames);
				usedFilenames.add(filename);
				const filePath = path.join(outputDir, filename);
				await fs.writeFile(filePath, markdown, "utf-8");

				results.push({
					url,
					file: filename,
					size: Buffer.byteLength(markdown, "utf-8"),
					status,
					note,
					rendered,
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

				const textFile = uniqueFilename(`${urlToBaseName(url)}.txt`, usedFilenames);
				const textPath = path.join(binaryDir, textFile);

				if (isPdf) {
					const nativeText = isPdftotextAvailable()
						? await extractPdfText(filePath, textPath)
						: null;
					if (nativeText !== null && hasSufficientText(nativeText)) {
						await fs.writeFile(textPath, nativeText, "utf-8");
						usedFilenames.add(textFile);
						item.textFile = textFile;
						item.textSource = "pdftotext";
					} else {
						try {
							const ocrText = await ocrPdf(filePath);
							if (hasSufficientText(ocrText, 1)) {
								await fs.writeFile(textPath, ocrText, "utf-8");
								usedFilenames.add(textFile);
								item.textFile = textFile;
								item.textSource = "ocr";
							} else if (nativeText !== null && nativeText.trim().length > 0) {
								await fs.writeFile(textPath, nativeText, "utf-8");
								usedFilenames.add(textFile);
								item.textFile = textFile;
								item.textSource = "pdftotext";
							} else {
								await fs.rm(textPath, { force: true }).catch(() => undefined);
							}
						} catch (error) {
							await fs.rm(textPath, { force: true }).catch(() => undefined);
							item.note = `pdftotext indisponível; OCR indisponível: ${error instanceof Error ? error.message : String(error)}`;
						}
					}
					if (!item.textFile && !item.note && !isPdftotextAvailable()) {
						item.note = "pdftotext e OCR indisponíveis — texto do PDF não extraído";
					}
				} else if (isImageFile(filePath)) {
					try {
						const ocrText = await recognizeImage(filePath);
						if (hasSufficientText(ocrText, 1)) {
							await fs.writeFile(textPath, ocrText, "utf-8");
							usedFilenames.add(textFile);
							item.textFile = textFile;
							item.textSource = "ocr";
						}
					} catch (error) {
						item.note = `OCR indisponível: ${error instanceof Error ? error.message : String(error)}`;
					}
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
