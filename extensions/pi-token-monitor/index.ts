import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import { UsageStore } from "./data.ts";
import { TokenMonitorPanel, type TokenMonitorQuery } from "./panel.ts";

const REFRESH_INTERVAL_MS = 1500;
const TOGGLE_DEBOUNCE_MS = 250;

export function shouldToggleTokenMonitor(data: string, now: number, lastToggleAt: number): boolean {
  return matchesKey(data, Key.alt("m")) && !isKeyRepeat(data) && now - lastToggleAt >= TOGGLE_DEBOUNCE_MS;
}

export default function (pi: ExtensionAPI): void {
  const store = new UsageStore();
  let activePanel: TokenMonitorPanel | null = null;
  let closeActivePanel: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let removeTerminalInputListener: (() => void) | undefined;
  let lastToggleAt = Number.NEGATIVE_INFINITY;
  let openingPanel = false;
  let refreshInFlight = false;

  const refreshPanel = async (ctx: ExtensionContext, panel: TokenMonitorPanel, query?: TokenMonitorQuery): Promise<void> => {
    if (activePanel !== panel || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const currentQuery = query ?? panel.getQuery();
      const snapshot = await store.snapshot({ ...currentQuery, now: Date.now() });
      if (activePanel === panel) panel.setSnapshot(snapshot);
    } finally {
      refreshInFlight = false;
    }
    void ctx;
  };

  const openPanel = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("O monitor de tokens requer o modo interativo (TUI).", "error");
      return;
    }
    if (activePanel) {
      closeActivePanel?.();
      return;
    }
    if (openingPanel) return;

    openingPanel = true;
    try {
      const initialSnapshot = await store.snapshot({ period: "today", now: Date.now() });
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const panel = new TokenMonitorPanel(
            tui,
            theme,
            initialSnapshot,
            (query) => void refreshPanel(ctx, panel, query),
            () => void refreshPanel(ctx, panel),
            done,
          );
          activePanel = panel;
          closeActivePanel = done;
          refreshTimer = setInterval(() => void refreshPanel(ctx, panel), REFRESH_INTERVAL_MS);
          return panel;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "92%",
            maxHeight: "92%",
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
      refreshInFlight = false;
    }
  };

  pi.registerCommand("token-monitor", {
    description: "Abre o painel de monitoramento de tokens",
    handler: async (_args, ctx) => openPanel(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    if (ctx.mode !== "tui") return;
    removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, Key.alt("m"))) return;
      const now = Date.now();
      if (shouldToggleTokenMonitor(data, now, lastToggleAt)) {
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
  pi.on("model_select", (_event, ctx) => {
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
