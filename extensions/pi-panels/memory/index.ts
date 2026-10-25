import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import { identifyProjectId, MemoryStore, readMemoryPreview } from "./data.ts";
import { MemoryDetailsPanel, MemoryPanel } from "./panel.ts";
import type { MemoryEntry, MemoryQuery } from "./types.ts";

const REFRESH_INTERVAL_MS = 2000;
const TOGGLE_DEBOUNCE_MS = 250;

export function shouldToggleMemoryPanel(data: string, now: number, lastToggleAt: number): boolean {
	return matchesKey(data, Key.alt("g")) && !isKeyRepeat(data) && now - lastToggleAt >= TOGGLE_DEBOUNCE_MS;
}

function resolveProjectId(ctx: ExtensionContext): string {
	try {
		return identifyProjectId(ctx.cwd);
	} catch {
		return "unknown";
	}
}

function openEntryPreview(ctx: ExtensionContext, store: MemoryStore, entry: MemoryEntry): void {
	const preview = readMemoryPreview(store.root, entry.path);
	void ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => new MemoryDetailsPanel(theme, entry, preview, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "80%", margin: 1 },
		},
	);
}

async function requestSearch(ctx: ExtensionContext, panel: MemoryPanel, apply: (query: MemoryQuery) => void): Promise<void> {
	if (!ctx.hasUI) return;
	const current = panel.getQuery().search;
	const value = await ctx.ui.input("Buscar memórias:", current);
	if (value === undefined) return;
	apply({ ...panel.getQuery(), search: value });
}

export default function (pi: ExtensionAPI): void {
	const store = new MemoryStore();
	let activePanel: MemoryPanel | null = null;
	let closeActivePanel: (() => void) | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let removeTerminalInputListener: (() => void) | undefined;
	let lastToggleAt = Number.NEGATIVE_INFINITY;
	let openingPanel = false;
	let refreshInFlight = false;

	const refreshPanel = async (ctx: ExtensionContext, panel: MemoryPanel, query?: MemoryQuery): Promise<void> => {
		if (activePanel !== panel || refreshInFlight) return;
		refreshInFlight = true;
		try {
			const snapshot = store.snapshot(resolveProjectId(ctx), query ?? panel.getQuery());
			if (activePanel === panel) panel.setSnapshot(snapshot);
		} finally {
			refreshInFlight = false;
		}
	};

	const openPanel = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui?.notify?.("O painel de memórias requer o modo interativo (TUI).", "error");
			return;
		}
		if (activePanel) {
			closeActivePanel?.();
			return;
		}
		if (openingPanel) return;
		openingPanel = true;
		try {
			const initialSnapshot = store.snapshot(resolveProjectId(ctx), { scope: "all", type: "all", search: "" });
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const panel = new MemoryPanel(tui, theme, initialSnapshot, {
						onQueryChange: (query) => void refreshPanel(ctx, panel, query),
						onRefresh: () => void refreshPanel(ctx, panel),
						onClose: done,
						onPreview: (entry) => openEntryPreview(ctx, store, entry),
						onSearch: () => void requestSearch(ctx, panel, (query) => void refreshPanel(ctx, panel, query)),
					});
					activePanel = panel;
					closeActivePanel = done;
					refreshTimer = setInterval(() => void refreshPanel(ctx, panel), REFRESH_INTERVAL_MS);
					return panel;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%", margin: 1 },
				},
			);
		} finally {
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = undefined;
			activePanel = null;
			closeActivePanel = null;
			openingPanel = false;
			refreshInFlight = false;
		}
	};

	pi.registerCommand("memory", {
		description: "Abre o painel de monitoramento de memórias (globais e do projeto)",
		handler: async (_args, ctx) => openPanel(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		if (ctx.mode !== "tui") return;
		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.alt("g"))) return;
			const now = Date.now();
			if (shouldToggleMemoryPanel(data, now, lastToggleAt)) {
				lastToggleAt = now;
				void openPanel(ctx);
			}
			return { consume: true };
		});
	});

	pi.on("message_end", (_event, ctx) => {
		if (activePanel) void refreshPanel(ctx, activePanel);
	});
	pi.on("turn_end", (_event, ctx) => {
		if (activePanel) void refreshPanel(ctx, activePanel);
	});
	pi.on("session_shutdown", () => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		activePanel = null;
		closeActivePanel = null;
	});
}
