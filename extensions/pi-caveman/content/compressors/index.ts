import { compressJson } from "./json.ts";
import { compressLog } from "./log.ts";
import type { CompressedType, CompressionResult } from "../../types.ts";

export function compressorFor(kind: CompressedType): (text: string) => CompressionResult | undefined {
	return kind === "json" ? compressJson : compressLog;
}
