import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { worker } = vi.hoisted(() => ({
	worker: {
		recognize: vi.fn().mockResolvedValue({ data: { text: "texto da imagem" } }),
		terminate: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("tesseract.js", () => ({
	createWorker: vi.fn().mockResolvedValue(worker),
}));

vi.mock("node:fs/promises", () => ({
	mkdtemp: vi.fn().mockResolvedValue("/tmp/pi-document-ocr-test"),
	readdir: vi.fn().mockResolvedValue(["page-1.png"]),
	rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const child = new EventEmitter();
		setImmediate(() => child.emit("close", 0));
		return child;
	}),
}));

import { createWorker } from "tesseract.js";
import {
	hasSufficientText,
	isImageFile,
	ocrPdf,
	recognizeImage,
} from "./ocr";

describe("ocr", () => {
	beforeEach(() => vi.clearAllMocks());

	it("identifica texto suficiente e imagens", () => {
		expect(hasSufficientText("Olá, mundo!", 5)).toBe(true);
		expect(hasSufficientText("...", 1)).toBe(false);
		expect(isImageFile("foto.PNG")).toBe(true);
		expect(isImageFile("documento.pdf")).toBe(false);
	});

	it("reconhece texto de uma imagem e termina o worker", async () => {
		expect(await recognizeImage("foto.png", { timeoutMs: 100 })).toBe("texto da imagem");
		expect(createWorker).toHaveBeenCalledWith("por+eng");
		expect(worker.terminate).toHaveBeenCalled();
	});

	it("renderiza PDF e reconhece suas páginas", async () => {
		expect(await ocrPdf("documento.pdf", { timeoutMs: 100 })).toBe("texto da imagem");
		expect(worker.recognize).toHaveBeenCalledWith("/tmp/pi-document-ocr-test/page-1.png");
	});
});
