import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractPdfText, isPdftotextAvailable } from "./pdf-text";
import { hasSufficientText, isImageFile, ocrPdf, recognizeImage } from "./ocr";

const MAX_DOCUMENT_SIZE = 25 * 1024 * 1024;

async function isPdfFile(filePath: string): Promise<boolean> {
	if (path.extname(filePath).toLowerCase() === ".pdf") return true;
	const handle = await fs.open(filePath, "r");
	try {
		const header = Buffer.alloc(5);
		await handle.read(header, 0, header.length, 0);
		return header.toString("latin1") === "%PDF-";
	} finally {
		await handle.close();
	}
}

async function extractDocument(filePath: string): Promise<{ text: string; source: "pdftotext" | "ocr" }> {
	if (isImageFile(filePath)) {
		return { text: await recognizeImage(filePath), source: "ocr" };
	}

	if (!(await isPdfFile(filePath))) {
		throw new Error("Formato não suportado. Informe o caminho de uma imagem ou PDF.");
	}

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-document-tool-"));
	const textPath = path.join(tempDir, "native.txt");
	try {
		const nativeText = isPdftotextAvailable() ? await extractPdfText(filePath, textPath) : null;
		if (nativeText !== null && hasSufficientText(nativeText)) {
			return { text: nativeText, source: "pdftotext" };
		}

		const ocrText = await ocrPdf(filePath);
		if (ocrText.trim()) return { text: ocrText, source: "ocr" };
		if (nativeText?.trim()) return { text: nativeText, source: "pdftotext" };
		throw new Error("Não foi possível extrair texto do PDF.");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Registra a ferramenta compartilhada de leitura de imagens e PDFs. */
export function registerDocumentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "document_extract",
		label: "Document Text Extraction",
		description:
			"Extracts text from a local image or PDF. Uses the PDF text layer when available and OCR as fallback.",
		parameters: Type.Object({
			path: Type.String({ description: "Local path to an image or PDF." }),
		}),
		async execute(_toolCallId, params) {
			const inputPath = (params as { path: string }).path?.trim();
			if (!inputPath) throw new Error("O caminho do documento é obrigatório.");

			const filePath = path.resolve(inputPath);
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) throw new Error("O caminho informado não é um arquivo.");
			if (stat.size > MAX_DOCUMENT_SIZE) {
				throw new Error(`Arquivo excede o limite de ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB.`);
			}

			const result = await extractDocument(filePath);
			if (!result.text.trim()) throw new Error("Nenhum texto foi reconhecido no documento.");

			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { path: filePath, source: result.source },
			};
		},
	});
}
