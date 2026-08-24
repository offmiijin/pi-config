import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { StatsTracker } from "./stats.ts";

export interface CavemanRuntimeState {
	enabled: boolean;
	ready: boolean;
}

function notify(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "info");
	else process.stderr.write(`${message}\n`);
}

function formatStats(stats: StatsTracker): string {
	const value = stats.snapshot();
	const saved = Math.max(0, value.originalBytes - value.outputBytes);
	return [
		`pi-caveman: ${value.compressed} compactados, ${value.skipped} ignorados`,
		`bytes: ${value.originalBytes} → ${value.outputBytes} (economizados: ${saved})`,
		`recuperações: ${value.recovered}; falhas: ${value.failures}`,
	].join("\n");
}

export function registerCavemanCommand(pi: ExtensionAPI, state: CavemanRuntimeState, stats: StatsTracker): void {
	pi.registerCommand("caveman", {
		description: "Exibe o status do pi-caveman ou altera sua ativação na sessão",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on" || command === "enable") {
				state.enabled = true;
				notify(ctx, "pi-caveman ativado nesta sessão.");
				return;
			}
			if (command === "off" || command === "disable") {
				state.enabled = false;
				notify(ctx, "pi-caveman desativado nesta sessão.");
				return;
			}
			if (command === "reset") {
				stats.reset();
				notify(ctx, "Estatísticas do pi-caveman zeradas.");
				return;
			}
			if (!command || command === "stats") {
				notify(ctx, `${state.ready ? "ativo" : "indisponível"}; ${state.enabled ? "habilitado" : "desabilitado"}\n${formatStats(stats)}`);
				return;
			}
			notify(ctx, "Uso: /caveman [stats|on|off|reset]");
		},
	});
}
