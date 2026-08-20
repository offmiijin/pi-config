const IMPORTANT = /\b(?:error|fatal|critical|exception|traceback|panic|fail(?:ed|ure)?|warn(?:ing)?)\b/i;
const NOISE = /\b(?:debug|info|heartbeat|polling|retrying|pass(?:ed|ing)?|progress)\b/i;
const TEST_COMMAND = /(?:^|[;&|])\s*(?:npm\s+(?:run\s+)?(?:test|lint|typecheck|build)|(?:pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build)|(?:npx\s+)?(?:vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|tsc|eslint|biome|ruff|mypy))(?:\s|$)/i;
const LOG_COMMAND = /(?:docker\s+(?:compose\s+)?logs?|kubectl\s+logs?|journalctl|tail\s+(?:-f|--follow)|(?:^|[\s;&|])logs?\b)/i;

interface TextBlock extends Record<string, unknown> {
	type: "text";
	text: string;
}

interface BashResult {
	content?: Array<Record<string, unknown>>;
	details?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface BashOutputCompaction {
	kind: "json" | "test" | "log" | "unknown";
	changed: boolean;
	output: string;
	reason?: string;
}

function unique(lines: string[]): string[] {
	return [...new Set(lines)];
}

function compactJson(text: string): BashOutputCompaction | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		const value = JSON.parse(trimmed) as unknown;
		const output = JSON.stringify(value);
		if (output.length >= text.length) return { kind: "json", changed: false, output: text, reason: "json já estava compacto" };
		return { kind: "json", changed: true, output, reason: "json-minificado" };
	} catch {
		return undefined;
	}
}

function compactLines(text: string, kind: "test" | "log"): BashOutputCompaction {
	const lines = text.split("\n");
	if (lines.length < 20) return { kind, changed: false, output: text, reason: "saída curta" };

	const important = lines.filter((line) => IMPORTANT.test(line));
	const kept = important.length > 0
		? unique([...lines.slice(0, 5), ...important, ...lines.slice(-10)])
		: lines.filter((line) => !NOISE.test(line));

	if (kept.length >= lines.length) return { kind, changed: false, output: text, reason: "sem ruído removível" };
	const omitted = lines.length - kept.length;
	return {
		kind,
		changed: true,
		output: [`[pi-sandbox] ${omitted} linhas de saída omitidas; falhas e resumo preservados.`, ...kept].join("\n"),
		reason: kind === "test" ? "saída repetitiva de teste filtrada" : "ruído de log filtrado",
	};
}

export function compactBashOutput(command: string, text: string): BashOutputCompaction {
	const json = compactJson(text);
	if (json) return json;
	if (TEST_COMMAND.test(command)) return compactLines(text, "test");
	if (LOG_COMMAND.test(command)) return compactLines(text, "log");
	return { kind: "unknown", changed: false, output: text, reason: "comando sem compressor seguro" };
}

export function compactBashToolResult(result: unknown, params: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const value = result as BashResult;
	if (!Array.isArray(value.content)) return result;
	const command = typeof params === "object" && params !== null && "command" in params
		? String((params as { command?: unknown }).command ?? "")
		: "";
	const textBlocks = value.content.filter((block): block is TextBlock => block?.type === "text" && typeof block.text === "string");
	if (textBlocks.length === 0) return result;
	const original = textBlocks.map((block) => block.text).join("");
	const outcome = compactBashOutput(command, original);
	if (!outcome.changed) return result;
	return {
		...value,
		content: [{ type: "text", text: outcome.output }, ...value.content.filter((block) => block?.type !== "text")],
		details: { ...value.details, piSandboxCompaction: { kind: outcome.kind, reason: outcome.reason } },
	};
}

export function compactBashToolError(error: unknown, params: unknown): Error {
	if (!(error instanceof Error)) return new Error(String(error));
	const command = typeof params === "object" && params !== null && "command" in params
		? String((params as { command?: unknown }).command ?? "")
		: "";
	const outcome = compactBashOutput(command, error.message);
	return outcome.changed ? new Error(outcome.output) : error;
}
