import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import { UsageStore, type UsageCatalog } from "./data.ts";
import type { UsageFilter, UsageRecord } from "./types.ts";
import {
  FilterSelector,
  LogDetailsPanel,
  TokenMonitorPanel,
  type FilterFocus,
  type FilterOption,
  type FilterSelection,
  type TokenMonitorQuery,
} from "./panel.ts";

const REFRESH_INTERVAL_MS = 1500;
const TOGGLE_DEBOUNCE_MS = 250;

function parseDateInput(value: string): number | null {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, day, month, year, hour = "00", minute = "00"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
  return date.getTime();
}

export async function requestCustomPeriod(ctx: ExtensionContext): Promise<{ from: number; to: number } | null> {
  if (!ctx.hasUI) return null;
  const fromText = await ctx.ui.input("Data inicial", "DD/MM/AAAA HH:mm");
  if (!fromText) return null;
  const toText = await ctx.ui.input("Data final", "DD/MM/AAAA HH:mm");
  if (!toText) return null;
  const from = parseDateInput(fromText);
  const to = parseDateInput(toText);
  if (from === null || to === null || from > to) {
    ctx.ui.notify("Período inválido. Use DD/MM/AAAA HH:mm, com a data inicial antes da final.", "error");
    return null;
  }
  return { from, to: to + 60_000 };
}

function getUsageCatalog(): UsageCatalog {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { configuredRouters: [] };
    return {
      configuredRouters: Object.entries(parsed)
        .filter(([, credential]) => credential !== null && typeof credential === "object")
        .map(([provider]) => provider)
        .sort(),
    };
  } catch {
    return { configuredRouters: [] };
  }
}

function filterTitle(focus: FilterFocus): string {
  if (focus === "period") return "Selecionar período";
  if (focus === "router") return "Selecionar router";
  return "Selecionar modelo";
}

function openLogDetails(ctx: ExtensionContext, record: UsageRecord): void {
  void ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => new LogDetailsPanel(theme, record, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        minWidth: 60,
        maxHeight: "80%",
        margin: 1,
      },
    },
  );
}

async function selectFilter(
  ctx: ExtensionContext,
  focus: FilterFocus,
  current: UsageFilter,
  options: readonly FilterOption[],
): Promise<FilterSelection | null> {
  const currentValue = focus === "period" ? current.period : focus === "router" ? current.router : current.model;
  const choice = await ctx.ui.custom<FilterSelection | null>(
    (tui, theme, _keybindings, done) => {
      const selector = new FilterSelector(
        filterTitle(focus),
        options,
        currentValue,
        (value) => done({ value }),
        () => done(null),
      );
      return {
        render: (width) => selector.render(width),
        handleInput: (data) => {
          selector.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => selector.invalidate(),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "45%",
        minWidth: 36,
        maxHeight: "65%",
        margin: 1,
      },
    },
  );
  if (!choice) return null;
  if (focus === "period" && choice.value === "custom") {
    const range = await requestCustomPeriod(ctx);
    return range ? { value: "custom", customFrom: range.from, customTo: range.to } : null;
  }
  return choice;
}

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
      const snapshot = await store.snapshot({ ...currentQuery, now: Date.now() }, getUsageCatalog());
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
      const initialSnapshot = await store.snapshot({ period: "today", now: Date.now() }, getUsageCatalog());
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const panel = new TokenMonitorPanel(
            tui,
            theme,
            initialSnapshot,
            (query) => void refreshPanel(ctx, panel, query),
            () => void refreshPanel(ctx, panel),
            done,
            (focus, current, options) => selectFilter(ctx, focus, current, options),
            (record) => openLogDetails(ctx, record),
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
