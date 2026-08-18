import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import { collectChanges } from "./git.ts";
import { ChangesPanel } from "./panel.ts";

const REFRESH_INTERVAL_MS = 1500;
const TOGGLE_DEBOUNCE_MS = 250;

export function shouldTogglePanel(data: string, now: number, lastToggleAt: number): boolean {
	return matchesKey(data, Key.alt("d")) && !isKeyRepeat(data) && now - lastToggleAt >= TOGGLE_DEBOUNCE_MS;
}

export default function (pi: ExtensionAPI): void {
	let activePanel: ChangesPanel | null = null;
	let closeActivePanel: (() => void) | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let openingPanel = false;
	let lastToggleAt = Number.NEGATIVE_INFINITY;
	let removeTerminalInputListener: (() => void) | undefined;

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
		if (openingPanel) return;

		openingPanel = true;
		try {
			const initialSnapshot = await loadChanges(ctx);
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
					anchor: "center",
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
			openingPanel = false;
		}
	};

	// Alt+D é tratado antes do editor para evitar o conflito com a ação
	// nativa `tui.editor.deleteWordForward`.
	pi.on("session_start", (_event, ctx) => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		if (ctx.mode !== "tui") return;

		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.alt("d"))) return;
			const now = Date.now();
			if (shouldTogglePanel(data, now, lastToggleAt)) {
				lastToggleAt = now;
				void openPanel(ctx);
			}
			// Consome também repetições para que o editor nunca execute deleteWordForward.
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
	});

	// Atualiza rapidamente após operações do agente; o polling cobre alterações
	// feitas por comandos bash e por processos externos.
	pi.on("tool_execution_end", (_event, ctx) => refreshPanel(ctx));
	pi.on("turn_end", (_event, ctx) => refreshPanel(ctx));
	pi.on("session_tree", (_event, ctx) => refreshPanel(ctx));
}
