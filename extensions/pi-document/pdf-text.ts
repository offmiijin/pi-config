import * as fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_PDF_TEXT_TIMEOUT_MS = 30_000;

let pdftotextAvailable: boolean | null = null;

/** Retorna true quando o executável pdftotext está disponível no PATH. */
export function isPdftotextAvailable(): boolean {
	if (pdftotextAvailable === null) {
		try {
			pdftotextAvailable = spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).error === undefined;
		} catch {
			pdftotextAvailable = false;
		}
	}
	return pdftotextAvailable;
}

/** Limpa o cache de disponibilidade, principalmente útil em testes. */
export function resetPdftotextAvailability(): void {
	pdftotextAvailable = null;
}

export interface ExtractPdfTextOptions {
	timeoutMs?: number;
}

/**
 * Extrai texto de um PDF usando `pdftotext -layout` (poppler-utils).
 *
 * O texto é salvo em `txtPath` e também retornado. Retorna null quando o
 * executável falha, excede o timeout ou não produz um arquivo legível.
 */
export async function extractPdfText(
	pdfPath: string,
	txtPath: string,
	options: ExtractPdfTextOptions = {},
): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | null): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const child = spawn(
			"pdftotext",
			["-layout", "-enc", "UTF-8", pdfPath, txtPath],
			{ stdio: "ignore" },
		);
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, options.timeoutMs ?? DEFAULT_PDF_TEXT_TIMEOUT_MS);

		child.on("error", () => {
			clearTimeout(timer);
			finish(null);
		});
		child.on("close", async (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				finish(null);
				return;
			}
			try {
				finish(await fs.readFile(txtPath, "utf-8"));
			} catch {
				finish(null);
			}
		});
	});
}
