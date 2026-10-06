import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../pdf-text", () => ({
	extractPdfText: vi.fn(),
	isPdftotextAvailable: vi.fn(),
}));

vi.mock("../ocr", () => ({
	hasSufficientText: vi.fn((text: string) => text.trim().length >= 20),
	isImageFile: vi.fn((filePath: string) => /\.png$/i.test(filePath)),
	ocrPdf: vi.fn(),
	recognizeImage: vi.fn(),
}));

import { extractPdfText, isPdftotextAvailable } from "../pdf-text";
import { hasSufficientText, ocrPdf, recognizeImage } from "../ocr";
import { registerDocumentTool } from "../tool";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{
	dir: string;
	execute: (params: { path: string }) => Promise<unknown>;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-document-tool-test-"));
	tempDirs.push(dir);
	let definition: { execute: (id: string, params: { path: string }) => Promise<unknown> } | undefined;
	registerDocumentTool({ registerTool: (tool: typeof definition) => { definition = tool; } } as never);
	if (!definition) throw new Error("document_extract não foi registrada");
	return { dir, execute: (params) => definition!.execute("test", params) };
}

describe("document_extract", () => {
	it("registra a tool com caminho local de imagem ou PDF", () => {
		const registerTool = vi.fn();
		registerDocumentTool({ registerTool } as never);

		expect(registerTool).toHaveBeenCalledOnce();
		expect(registerTool.mock.calls[0][0]).toMatchObject({
			name: "document_extract",
			label: "Document Text Extraction",
		});
		expect(typeof registerTool.mock.calls[0][0].execute).toBe("function");
	});

	it("valida caminho, arquivo e limite de tamanho", async () => {
		const { dir, execute } = await setup();
		await expect(execute({ path: " " })).rejects.toThrow("obrigatório");
		await expect(execute({ path: path.join(dir, "missing.png") })).rejects.toThrow();
		await expect(execute({ path: dir })).rejects.toThrow("não é um arquivo");

		const large = path.join(dir, "large.png");
		await fs.writeFile(large, "");
		await fs.truncate(large, 25 * 1024 * 1024 + 1);
		await expect(execute({ path: large })).rejects.toThrow("25 MB");
	});

	it("extrai imagem via OCR e informa a fonte", async () => {
		const { dir, execute } = await setup();
		const image = path.join(dir, "foto.png");
		await fs.writeFile(image, "fake image");
		vi.mocked(recognizeImage).mockResolvedValue("texto reconhecido");

		await expect(execute({ path: image })).resolves.toMatchObject({
			content: [{ type: "text", text: "texto reconhecido" }],
			details: { source: "ocr", path: image },
		});
	});

	it("extrai PDF pelo texto nativo quando disponível", async () => {
		const { dir, execute } = await setup();
		const pdf = path.join(dir, "documento.pdf");
		await fs.writeFile(pdf, "%PDF-1.7 conteúdo");
		vi.mocked(isPdftotextAvailable).mockReturnValue(true);
		vi.mocked(extractPdfText).mockResolvedValue("texto nativo suficientemente longo");
		vi.mocked(hasSufficientText).mockReturnValue(true);

		await expect(execute({ path: pdf })).resolves.toMatchObject({ details: { source: "pdftotext" } });
		expect(ocrPdf).not.toHaveBeenCalled();
	});

	it("rejeita arquivo com extensão PDF sem assinatura PDF", async () => {
		const { dir, execute } = await setup();
		const invalid = path.join(dir, "documento.pdf");
		await fs.writeFile(invalid, "não é PDF");

		await expect(execute({ path: invalid })).rejects.toThrow("Formato não suportado");
	});
});
