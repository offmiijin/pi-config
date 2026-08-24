import type { CompressionResult } from "../../types.ts";

export function compressJson(text: string): CompressionResult | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}

	const output = JSON.stringify(value);
	if (typeof output !== "string") return undefined;
	return {
		kind: "json",
		output,
		reason: output.length < text.length ? "json-minificado" : "json já estava compacto",
	};
}
