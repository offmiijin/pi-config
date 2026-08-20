import { createHash } from "node:crypto";

const HANDLE_PATTERN = /^ccr_[0-9a-f]{32}$/;

export function handleFor(content: string): string {
	const digest = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
	return `ccr_${digest.slice(0, 32)}`;
}

export function isRecoveryHandle(value: unknown): value is string {
	return typeof value === "string" && HANDLE_PATTERN.test(value);
}
