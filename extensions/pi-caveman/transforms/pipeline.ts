import { compressorFor } from "../content/compressors/index.ts";
import { detectContent } from "../content/detector.ts";
import { handleFor } from "../recovery/handles.ts";
import type { RecoveryStore } from "../recovery/store.ts";
import type { CavemanConfig, CompressionOutcome } from "../types.ts";

export const RECOVERY_TOOL_NAME = "caveman_retrieve";

/**
 * Outputs dessas tools já são limitados/compactados pela própria implementação
 * do Pi ou pelo pi-sandbox. O Caveman não deve fazer uma segunda passagem.
 */
export const PI_NATIVE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
]);

export function isPiNativeTool(toolName: string): boolean {
	return PI_NATIVE_TOOL_NAMES.has(toolName);
}

function recoveryNotice(handle: string): string {
	return `\n\n[pi-caveman] Conteúdo reduzido; original disponível em <<ccr:${handle}>>. Use caveman_retrieve para recuperar.`;
}

function unchanged(text: string, type: CompressionOutcome["type"], reason: string): CompressionOutcome {
	const bytes = Buffer.byteLength(text, "utf8");
	return { content: text, changed: false, type, originalBytes: bytes, outputBytes: bytes, reason };
}

export async function compressToolOutput(
	text: string,
	toolName: string,
	config: CavemanConfig,
	store: RecoveryStore,
): Promise<CompressionOutcome> {
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (toolName === RECOVERY_TOOL_NAME) return unchanged(text, "unknown", "resultado de recuperação não é recompactado");
	if (isPiNativeTool(toolName)) return unchanged(text, "unknown", "resultado já tratado pela tool nativa do Pi");
	if (originalBytes < config.minBytes) return unchanged(text, "unknown", "abaixo do tamanho mínimo");
	if (originalBytes > config.maxInputBytes) return unchanged(text, "unknown", "acima do limite de entrada");

	const type = detectContent(text, toolName);
	if (type !== "json" && type !== "log") return unchanged(text, type, "tipo sem compressor ativo");

	const compressed = compressorFor(type)(text);
	if (!compressed) return unchanged(text, type, "compressor recusou a entrada");

	const handle = handleFor(text);
	const output = `${compressed.output}${recoveryNotice(handle)}`;
	const outputBytes = Buffer.byteLength(output, "utf8");
	if (originalBytes - outputBytes < config.minSavingsBytes) {
		return unchanged(text, type, "economia abaixo do mínimo");
	}

	try {
		await store.put(text);
	} catch {
		return unchanged(text, type, "não foi possível armazenar o original");
	}

	return {
		content: output,
		changed: true,
		type,
		handle,
		originalBytes,
		outputBytes,
		reason: compressed.reason,
	};
}
