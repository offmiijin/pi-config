export const COMPRESSED_TYPES = ["json", "log"] as const;
export type CompressedType = (typeof COMPRESSED_TYPES)[number];
export type ContentType = CompressedType | "text" | "unknown";

export interface CavemanConfig {
	enabled: boolean;
	minBytes: number;
	maxInputBytes: number;
	minSavingsBytes: number;
	dataDir: string;
}

export interface CompressionResult {
	output: string;
	kind: CompressedType;
	reason?: string;
}

export interface RecoveryObject {
	handle: string;
	bytes: number;
	created: boolean;
}

export interface CompressionOutcome {
	content: string;
	changed: boolean;
	type: ContentType;
	handle?: string;
	originalBytes: number;
	outputBytes: number;
	reason?: string;
}

export interface CavemanStatsSnapshot {
	seen: number;
	compressed: number;
	skipped: number;
	originalBytes: number;
	outputBytes: number;
	recovered: number;
	failures: number;
}
