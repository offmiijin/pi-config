import type { ContentType } from "../types.ts";

const LOG_LINE_PATTERN = /(?:\b(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/i;
const LOG_SIGNAL_PATTERN = /\b(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|exception|traceback|panic|stack trace)\b/i;

export function detectContent(text: string, toolName = ""): ContentType {
	const trimmed = text.trim();
	if (!trimmed) return "unknown";

	try {
		JSON.parse(trimmed);
		return "json";
	} catch {
		// JSON inválido deve seguir para detecção textual, nunca para um parser
		// parcial que possa produzir uma transformação enganosa.
	}

	const lines = text.split("\n");
	const logLines = lines.filter((line) => LOG_LINE_PATTERN.test(line)).length;
	const signalLines = lines.filter((line) => LOG_SIGNAL_PATTERN.test(line)).length;
	const toolSuggestsLog = /(?:bash|shell|exec|command|terminal|log)/i.test(toolName);
	if (lines.length >= 8 && (logLines >= Math.ceil(lines.length * 0.35) || (toolSuggestsLog && signalLines >= 2))) {
		return "log";
	}
	return "text";
}
