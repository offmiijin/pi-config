import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { registerCavemanCommand, type CavemanRuntimeState } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { registerRecoveryTool } from "./recovery/tool.ts";
import { RecoveryStore } from "./recovery/store.ts";
import { StatsTracker } from "./stats.ts";
import { transformToolResult } from "./transforms/tool-output.ts";

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, kind);
	else if (kind === "warning") process.stderr.write(`pi-caveman: ${message}\n`);
}

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	const store = new RecoveryStore(config.dataDir);
	const stats = new StatsTracker();
	const state: CavemanRuntimeState = { enabled: config.enabled, ready: false };

	registerRecoveryTool(pi, store, { onRecovered: () => stats.recordRecovery() });
	registerCavemanCommand(pi, state, stats);

	pi.on("session_start", async (_event, ctx) => {
		try {
			await store.open();
			state.ready = true;
		} catch {
			state.ready = false;
			notify(ctx, "store de recuperação indisponível; resultados serão mantidos intactos", "warning");
		}
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		if (!state.enabled || !state.ready) return undefined;
		try {
			return await transformToolResult(event, config, store, {
				onOutcome: (outcome) => stats.record(outcome),
			}, ctx);
		} catch {
			stats.recordFailure();
			return undefined;
		}
	});

	pi.on("session_shutdown", async () => {
		store.close();
		state.ready = false;
	});
}
