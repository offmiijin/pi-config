import type { CompressionResult } from "../../types.ts";

const IMPORTANT = /\b(?:error|fatal|critical|exception|traceback|panic|failed|failure|warn(?:ing)?)\b/i;
const NOISE = /\b(?:trace|debug|info|heartbeat|progress|polling|retrying)\b/i;

function unique(lines: string[]): string[] {
	return [...new Set(lines)];
}

export function compressLog(text: string): CompressionResult | undefined {
	const lines = text.split("\n");
	if (lines.length < 20) return undefined;

	const important = lines.filter((line) => IMPORTANT.test(line));
	let kept: string[];
	if (important.length > 0 && lines.length > 80) {
		kept = unique([...lines.slice(0, 12), ...important, ...lines.slice(-12)]);
	} else {
		kept = lines.filter((line) => !NOISE.test(line));
		if (kept.length === lines.length) return undefined;
	}

	if (kept.length >= lines.length) return undefined;
	const omitted = lines.length - kept.length;
	const output = [
		`[pi-caveman] ${omitted} linhas de log omitidas; linhas relevantes preservadas.`,
		...kept,
	].join("\n");
	return { kind: "log", output, reason: "linhas de ruído removidas" };
}
