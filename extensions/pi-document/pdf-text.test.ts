import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("texto extraído"),
}));

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ error: undefined })),
	spawn: vi.fn(() => {
		const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
		child.kill = vi.fn();
		setImmediate(() => child.emit("close", 0));
		return child;
	}),
}));

import { spawnSync } from "node:child_process";
import {
	extractPdfText,
	isPdftotextAvailable,
	resetPdftotextAvailability,
} from "./pdf-text";

describe("pdf-text", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetPdftotextAvailability();
	});

	it("detecta pdftotext e extrai o texto para o arquivo de saída", async () => {
		expect(isPdftotextAvailable()).toBe(true);
		expect(await extractPdfText("documento.pdf", "documento.txt")).toBe("texto extraído");
	});

	it("memoriza quando pdftotext não está disponível", () => {
		vi.mocked(spawnSync).mockReturnValueOnce({ error: new Error("ENOENT") } as never);

		expect(isPdftotextAvailable()).toBe(false);
		expect(isPdftotextAvailable()).toBe(false);
		expect(spawnSync).toHaveBeenCalledTimes(1);
	});

	it("retorna null quando o processo falha", async () => {
		const childProcess = await import("node:child_process");
		const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
		child.kill = vi.fn();
		vi.mocked(childProcess.spawn).mockReturnValueOnce(child as never);

		const extraction = extractPdfText("documento.pdf", "documento.txt");
		child.emit("close", 1);

		expect(await extraction).toBeNull();
	});
});
