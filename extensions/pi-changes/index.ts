import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectChanges } from "./git.ts";
import { ChangesPanel } from "./panel.ts";

const REFRESH_INTERVAL_MS = 1500;

export default function (pi: ExtensionAPI): void {
	let activePanel: ChangesPanel | null = null;
	let closeActivePanel: (() => void) | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	const loadChanges = (ctx: ExtensionContext) =>
		collectChanges(ctx.cwd, async (args) => pi.exec("git", args, { timeout: 5000 }));

	const refreshPanel = (ctx: ExtensionContext): void => {
		const panel = activePanel;
		if (!panel) return;
		void loadChanges(ctx).then((snapshot) => {
			if (activePanel === panel) panel.setSnapshot(snapshot);
		});
	};

	const openPanel = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("O painel de alterações requer o modo interativo (TUI).", "error");
			return;
		}

		if (activePanel) {
			closeActivePanel?.();
			return;
		}

		const initialSnapshot = await loadChanges(ctx);
		try {
			await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const panel = new ChangesPanel(tui, theme, initialSnapshot, done);
				activePanel = panel;
				closeActivePanel = done;
				refreshTimer = setInterval(() => refreshPanel(ctx), REFRESH_INTERVAL_MS);
				return panel;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "left-center",
					width: "85%",
					maxHeight: "90%",
					margin: 1,
				},
			},
			);
		} finally {
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = undefined;
			activePanel = null;
			closeActivePanel = null;
		}
	};

	pi.registerShortcut("alt+d", {
		description: "Abrir ou fechar o painel de alterações",
		handler: openPanel,
	});

	// Atualiza rapidamente após operações do agente; o polling cobre alterações
	// feitas por comandos bash e por processos externos.
	pi.on("tool_execution_end", (_event, ctx) => refreshPanel(ctx));
	pi.on("turn_end", (_event, ctx) => refreshPanel(ctx));
	pi.on("session_tree", (_event, ctx) => refreshPanel(ctx));
}
