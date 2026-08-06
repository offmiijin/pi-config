/**
 * pi-memory — memory_status tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getObservationStatus } from "../session.ts";
import { StatusSchema } from "../schemas.ts";
import type { ToolState } from "./state.ts";

export function registerMemoryStatus(pi: ExtensionAPI, state: ToolState): void {
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Returns current observation count and threshold. " +
			"Call periodically; when count nears ~50, run memory_extract. " +
			"NATIVE pi tool — call memory_status directly, NOT via mcp({ tool: 'memory_status' }) or the mcp gateway.",
		promptSnippet:
			"memory_status: Check observation count (extract at ~50)",
		parameters: StatusSchema,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!state.projectId || !state.currentSessionHash) {
				return {
					content: [{ type: "text", text: "Error: no active session" }],
					details: { error: "no_active_session" },
				};
			}

			const status = getObservationStatus(state.projectId, state.currentSessionHash);
			const remaining = Math.max(0, status.threshold - status.observation_count);

			const text = [
				`Observations: ${status.observation_count}/${status.threshold}`,
				`Remaining until extraction: ${remaining}`,
				`Session file: ${status.session_file}`,
				remaining === 0
					? "Threshold reached — call memory_extract now."
					: `Continue working. Call memory_status periodically.`,
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: status,
			};
		},
	});
}
