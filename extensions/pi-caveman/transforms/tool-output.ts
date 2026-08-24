import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { RecoveryStore } from "../recovery/store.ts";
import type { CavemanConfig, CompressionOutcome } from "../types.ts";
import { compressToolOutput, isPiNativeTool, RECOVERY_TOOL_NAME } from "./pipeline.ts";

export interface ToolOutputCallbacks {
	onOutcome?(outcome: CompressionOutcome, ctx: ExtensionContext): void;
}

export async function transformToolResult(
	event: ToolResultEvent,
	_config: CavemanConfig,
	store: RecoveryStore,
	callbacks: ToolOutputCallbacks = {},
	ctx: ExtensionContext,
): Promise<{ content?: ToolResultEvent["content"] } | undefined> {
	if (event.toolName === RECOVERY_TOOL_NAME || isPiNativeTool(event.toolName)) return undefined;
	const text = event.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	if (!text) return undefined;

	const outcome = await compressToolOutput(text, event.toolName, _config, store);
	callbacks.onOutcome?.(outcome, ctx);
	if (!outcome.changed) return undefined;

	const nonText = event.content.filter((block) => block.type !== "text");
	return { content: [{ type: "text", text: outcome.content }, ...nonText] };
}
