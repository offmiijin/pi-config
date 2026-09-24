import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createWorker } from "tesseract.js";

export const DEFAULT_OCR_LANGUAGES = "por+eng";
export const DEFAULT_OCR_DPI = 150;
export const DEFAULT_OCR_MAX_PAGES = 20;
export const DEFAULT_OCR_TIMEOUT_MS = 120_000;
export const DEFAULT_MINIMUM_TEXT_LENGTH = 20;

export interface OcrOptions {
	languages?: string;
	dpi?: number;
	maxPages?: number;
	timeoutMs?: number;
	minimumTextLength?: number;
}

/** Texto com quantidade suficiente de caracteres alfanuméricos para evitar OCR desnecessário. */
export function hasSufficientText(text: string, minimumLength = DEFAULT_MINIMUM_TEXT_LENGTH): boolean {
	const meaningfulText = text.replace(/\s/g, "").replace(/[^\p{L}\p{N}]/gu, "");
	return meaningfulText.length >= minimumLength;
}

/** Retorna true para extensões de imagem suportadas pelo fluxo de OCR. */
export function isImageFile(filePath: string): boolean {
	return /\.(?:bmp|gif|jpe?g|png|webp|tiff?)$/i.test(filePath);
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn(command, args, { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			finish(false);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code === 0);
		});
	});
}

async function renderPdfPages(pdfPath: string, outputDir: string, options: Required<Pick<OcrOptions, "dpi" | "maxPages" | "timeoutMs">>): Promise<string[]> {
	const prefix = path.join(outputDir, "page");
	const ok = await runCommand(
		"pdftoppm",
		["-png", "-r", String(options.dpi), "-f", "1", "-l", String(options.maxPages), pdfPath, prefix],
		options.timeoutMs,
	);
	if (!ok) return [];

	const files = await fs.readdir(outputDir);
	return files
		.filter((file) => /^page-\d+\.png$/i.test(file))
		.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
		.map((file) => path.join(outputDir, file));
}

async function recognizeImages(imagePaths: string[], options: Required<Pick<OcrOptions, "languages" | "timeoutMs">>): Promise<string> {
	if (imagePaths.length === 0) return "";
	const worker = await createWorker(options.languages);
	const texts: string[] = [];
	try {
		for (const imagePath of imagePaths) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					worker.recognize(imagePath),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("OCR timeout")), options.timeoutMs);
					}),
				]);
				texts.push(result.data.text);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		return texts.join("\n\n").trim();
	} finally {
		await worker.terminate();
	}
}

/** Executa OCR em uma imagem existente. */
export async function recognizeImage(imagePath: string, options: OcrOptions = {}): Promise<string> {
	return recognizeImages([imagePath], {
		languages: options.languages ?? DEFAULT_OCR_LANGUAGES,
		timeoutMs: options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
	});
}

/** Renderiza as páginas iniciais de um PDF e executa OCR nelas. */
export async function ocrPdf(pdfPath: string, options: OcrOptions = {}): Promise<string> {
	const renderDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-document-ocr-"));
	try {
		const imagePaths = await renderPdfPages(pdfPath, renderDir, {
			dpi: options.dpi ?? DEFAULT_OCR_DPI,
			maxPages: options.maxPages ?? DEFAULT_OCR_MAX_PAGES,
			timeoutMs: options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
		});
		return await recognizeImages(imagePaths, {
			languages: options.languages ?? DEFAULT_OCR_LANGUAGES,
			timeoutMs: options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
		});
	} finally {
		await fs.rm(renderDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
