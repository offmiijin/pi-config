import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLIPBOARD_PATH = /\/tmp\/pi-clipboard-[a-f0-9-]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)/gi;

async function uniqueTarget(dir: string, extension: string): Promise<string> {
	let index = 1;
	while (true) {
		const name = index === 1 ? `imagem.${extension}` : `imagem-${index}.${extension}`;
		try {
			await fs.access(path.join(dir, name));
			index++;
		} catch {
			return path.join(dir, name);
		}
	}
}

/** Copia imagens temporárias do clipboard para uma área acessível ao sandbox. */
export async function materializeClipboardPaths(text: string, cwd: string, sessionId: string): Promise<string> {
	const matches = [...text.matchAll(CLIPBOARD_PATH)];
	if (matches.length === 0) return text;

	const dir = path.join(cwd, ".sandbox-cache", "attachments", sessionId);
	await fs.mkdir(dir, { recursive: true });
	let result = text;
	for (const match of matches) {
		const sourcePath = match[0];
		try {
			const stat = await fs.stat(sourcePath);
			if (!stat.isFile()) continue;
			const extension = path.extname(sourcePath).slice(1).toLowerCase();
			const targetPath = await uniqueTarget(dir, extension);
			await fs.copyFile(sourcePath, targetPath);
			result = result.replace(sourcePath, targetPath);
		} catch {
			// O arquivo pode ter sido removido pelo processo que gerencia o clipboard.
		}
	}
	return result;
}

/**
 * Adiciona uma ponte no envio do prompt. O editor permanece intocado; somente
 * o caminho temporário é materializado antes de chegar às tools do agente.
 */
export function registerClipboardPathBridge(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const text = await materializeClipboardPaths(event.text, ctx.cwd, ctx.sessionManager.getSessionId());
		return text === event.text ? { action: "continue" } : { action: "transform", text };
	});
}
