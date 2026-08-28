import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { PeriodPreset, TokenMonitorView, UsageFilter, UsageGroup, UsageRecord, UsageSnapshot } from "./types.ts";

export const PERIOD_OPTIONS: ReadonlyArray<{ id: PeriodPreset; label: string }> = [
  { id: "last15m", label: "Últimos 15 min" },
  { id: "last30m", label: "Últimos 30 min" },
  { id: "last1h", label: "Última hora" },
  { id: "last3h", label: "Últimas 3 horas" },
  { id: "last24h", label: "Últimas 24 horas" },
  { id: "last48h", label: "Últimas 48 horas" },
  { id: "last7d", label: "Últimos 7 dias" },
  { id: "last30d", label: "Últimos 30 dias" },
  { id: "last365d", label: "Últimos 365 dias" },
  { id: "today", label: "Hoje" },
  { id: "yesterday", label: "Ontem" },
  { id: "thisWeek", label: "Esta semana" },
  { id: "lastWeek", label: "Semana passada" },
  { id: "thisMonth", label: "Este mês" },
  { id: "lastMonth", label: "Mês passado" },
  { id: "thisYear", label: "Este ano" },
  { id: "lastYear", label: "Ano passado" },
  { id: "custom", label: "Data personalizada" },
];

const VIEWS: readonly TokenMonitorView[] = ["overview", "table", "logs"];
const VIEW_LABELS: Record<TokenMonitorView, string> = {
  overview: "Resumo",
  table: "Tabela",
  logs: "Logs",
};
const FILTERS = ["period", "router", "model"] as const;
type FocusArea = "filters" | "content";
const LOG_PAGE_SIZE = 50;

function formatCompact(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString("pt-BR");
}

function formatCost(value: number): string {
  return `$${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLogCost(value: number): string {
  return `$${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/d" : `${(value * 100).toFixed(1)}%`;
}

function groupLabel(group: UsageGroup): string {
  return group.label.length > 38 ? `${group.label.slice(0, 35)}...` : group.label;
}

function formatLogDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LOG_HEADERS = ["Data", "Modelo", "Provedor", "Tot. Tok.", "Tok. Ent.", "Tok. Saída", "Cache R/W", "Custo", "Sessão"];
const LOG_NATURAL_WIDTHS = [16, 20, 12, 15, 12, 12, 10, 10];
const LOG_MINIMUM_WIDTHS = [16, 6, 8, 15, 9, 10, 9, 5];

function logColumnGap(totalWidth: number): number {
  if (totalWidth >= 110) return 2;
  if (totalWidth >= 60) return 1;
  return 0;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function sameFilter(left: UsageFilter, right: UsageFilter): boolean {
  return left.period === right.period
    && left.model === right.model
    && left.router === right.router
    && left.customFrom === right.customFrom
    && left.customTo === right.customTo;
}

function fitLogColumnWidths(totalWidth: number, sessionWidth: number): { widths: number[]; gap: number } {
  const gap = logColumnGap(totalWidth);
  const natural = [...LOG_NATURAL_WIDTHS, sessionWidth];
  const minimum = [...LOG_MINIMUM_WIDTHS, sessionWidth];
  const target = Math.max(LOG_HEADERS.length, totalWidth - (LOG_HEADERS.length - 1) * gap - 1);
  const widths = [...minimum];
  let remaining = Math.max(0, target - widths.reduce((sum, width) => sum + width, 0));
  while (remaining > 0) {
    let changed = false;
    for (let index = 0; index < widths.length && remaining > 0; index++) {
      if (widths[index]! >= natural[index]!) continue;
      widths[index] = widths[index]! + 1;
      remaining--;
      changed = true;
    }
    if (!changed) break;
  }
  while (widths.reduce((sum, width) => sum + width, 0) > target) {
    const index = widths.findIndex((width, candidate) => candidate > 0 && candidate < widths.length - 1 && width > 1);
    if (index < 0) break;
    widths[index] = widths[index]! - 1;
  }
  return { widths, gap };
}

export interface TokenMonitorQuery extends UsageFilter {
  now?: number;
}

export type FilterFocus = "period" | "router" | "model";
export interface FilterOption {
  value: string | undefined;
  label: string;
}
export interface FilterSelection {
  value?: string;
  customFrom?: number;
  customTo?: number;
}
export type FilterSelectCallback = (
  focus: FilterFocus,
  current: UsageFilter,
  options: readonly FilterOption[],
) => Promise<FilterSelection | null>;
export type LogSelectCallback = (record: UsageRecord) => void;

export class FilterSelector implements Component {
  private selectedIndex: number;
  private readonly options: readonly FilterOption[];
  private readonly title: string;
  private readonly onSelect: (value: string | undefined) => void;
  private readonly onCancel: () => void;

  constructor(
    title: string,
    options: readonly FilterOption[],
    currentValue: string | undefined,
    onSelect: (value: string | undefined) => void,
    onCancel: () => void,
  ) {
    this.title = title;
    this.options = options;
    this.selectedIndex = Math.max(0, options.findIndex((option) => option.value === currentValue));
    this.onSelect = onSelect;
    this.onCancel = onCancel;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selectedIndex = Math.min(Math.max(0, this.options.length - 1), this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.onSelect(this.options[this.selectedIndex]?.value);
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines = [
      `╭${"─".repeat(innerWidth)}╮`,
      `│${this.pad(` ${this.title}`, innerWidth)}│`,
      `├${"─".repeat(innerWidth)}┤`,
    ];
    const maxOptions = Math.max(1, Math.min(12, this.options.length));
    const offset = Math.min(
      Math.max(0, this.selectedIndex - maxOptions + 1),
      Math.max(0, this.options.length - maxOptions),
    );
    for (let index = offset; index < Math.min(this.options.length, offset + maxOptions); index++) {
      const option = this.options[index]!;
      const marker = index === this.selectedIndex ? "▶ " : "  ";
      lines.push(`│${this.pad(`${marker}${option.label}`, innerWidth)}│`);
    }
    lines.push(`├${"─".repeat(innerWidth)}┤`);
    lines.push(`│${this.pad(" ↑↓ navegar  Enter selecionar  Esc cancelar ", innerWidth)}│`);
    lines.push(`╰${"─".repeat(innerWidth)}╯`);
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  private pad(content: string, width: number): string {
    const value = truncateToWidth(content, width, "");
    return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
  }
}

export class LogDetailsPanel implements Component {
  private readonly theme: Theme;
  private readonly record: UsageRecord;
  private readonly onClose: () => void;

  constructor(theme: Theme, record: UsageRecord, onClose: () => void) {
    this.theme = theme;
    this.record = record;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.alt("m"))) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const row = (content: string): string => `│${this.pad(content, innerWidth)}│`;
    const separator = `├${"─".repeat(innerWidth)}┤`;
    const valueWidth = Math.max(1, innerWidth - 20);
    const fields: Array<[string, string]> = [
      ["Data", formatLogDate(this.record.timestamp)],
      ["Modelo", this.record.model],
      ["Provedor", this.record.provider],
      ["Total Tokens", formatCompact(this.record.totalTokens)],
      ["Tok. Entrada", formatCompact(this.record.input)],
      ["Tok. Saída", formatCompact(this.record.output)],
      ["Cache R/W", `${formatCompact(this.record.cacheRead)} / ${formatCompact(this.record.cacheWrite)}`],
      ["Custo", formatCost(this.record.costTotal)],
      ["Sessão", shortSessionId(this.record.sessionId)],
    ];
    const lines = [
      `╭${"─".repeat(innerWidth)}╮`,
      row(this.theme.fg("accent", this.theme.bold(" DETALHES DO LOG"))),
      separator,
      ...fields.map(([label, value]) => row(` ${this.theme.fg("muted", this.pad(`${label}:`, 16))} ${truncateToWidth(value, valueWidth, "")}`)),
      separator,
      row(this.theme.fg("dim", " Esc fechar ")),
      `╰${"─".repeat(innerWidth)}╯`,
    ];
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  dispose(): void {}

  private pad(content: string, width: number): string {
    const value = truncateToWidth(content, width, "");
    return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
  }
}

export class TokenMonitorPanel implements Component {
  private snapshot: UsageSnapshot;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly onQueryChange: (query: TokenMonitorQuery) => void;
  private readonly onRefresh: () => void;
  private readonly onFilterSelect?: FilterSelectCallback;
  private readonly onLogSelect?: LogSelectCallback;
  private view: TokenMonitorView = "overview";
  private focusArea: FocusArea = "filters";
  private filterFocus: FilterFocus = "period";
  private selectedRow = 0;
  private logsPage = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    snapshot: UsageSnapshot,
    onQueryChange: (query: TokenMonitorQuery) => void,
    onRefresh: () => void,
    onClose: () => void,
    onFilterSelect?: FilterSelectCallback,
    onLogSelect?: LogSelectCallback,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.snapshot = snapshot;
    this.onQueryChange = onQueryChange;
    this.onRefresh = onRefresh;
    this.onClose = onClose;
    this.onFilterSelect = onFilterSelect;
    this.onLogSelect = onLogSelect;
  }

  setSnapshot(snapshot: UsageSnapshot): void {
    if (!sameFilter(this.snapshot.filter, snapshot.filter)) {
      this.logsPage = 0;
      this.selectedRow = 0;
    }
    this.snapshot = snapshot;
    this.logsPage = Math.min(this.logsPage, this.lastLogsPage());
    this.clampSelectedRow();
    this.tui.requestRender();
  }

  getQuery(): TokenMonitorQuery {
    return { ...this.snapshot.filter };
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.alt("m"))) {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.focusArea = this.focusArea === "content" ? "filters" : "content";
      this.tui.requestRender();
      return;
    }
    if (data === "v") {
      this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!;
      this.clampSelectedRow();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.focusArea === "filters" && this.onFilterSelect) {
        void this.onFilterSelect(this.filterFocus, this.snapshot.filter, this.filterOptions()).then((selection) => {
          if (selection) this.applyFilterSelection(selection);
        });
      } else if (this.focusArea === "content" && this.view === "logs" && this.onLogSelect) {
        const record = this.pageRecords()[this.selectedRow];
        if (record) this.onLogSelect(record);
      }
      return;
    }
    if (this.focusArea === "content" && this.view === "logs" && matchesKey(data, Key.pageUp)) {
      this.changeLogsPage(-1);
      return;
    }
    if (this.focusArea === "content" && this.view === "logs" && matchesKey(data, Key.pageDown)) {
      this.changeLogsPage(1);
      return;
    }
    if (data === "r") {
      this.onRefresh();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (this.focusArea === "content" && (this.view === "table" || this.view === "logs")) {
        const delta = matchesKey(data, Key.up) ? -1 : 1;
        const maxRow = this.view === "table" ? this.snapshot.models.length - 1 : this.pageRecords().length - 1;
        this.selectedRow = Math.max(0, Math.min(maxRow, this.selectedRow + delta));
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      if (this.focusArea === "filters") {
        const delta = matchesKey(data, Key.left) ? -1 : 1;
        this.filterFocus = FILTERS[(FILTERS.indexOf(this.filterFocus) + delta + FILTERS.length) % FILTERS.length]!;
        this.tui.requestRender();
      }
      return;
    }
    if (this.focusArea === "content" && (data === "j" || data === "J")) {
      const maxRow = this.view === "table" ? this.snapshot.models.length - 1 : this.pageRecords().length - 1;
      this.selectedRow = Math.min(maxRow, this.selectedRow + 1);
      this.tui.requestRender();
    } else if (this.focusArea === "content" && (data === "k" || data === "K")) {
      this.selectedRow = Math.max(0, this.selectedRow - 1);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 52) return [truncateToWidth(this.theme.fg("warning", "Terminal muito estreito para o monitor de tokens."), width, "")];
    const innerWidth = width - 2;
    const lines: string[] = [];
    const row = (content: string): string => `│${this.pad(content, innerWidth)}│`;
    const separator = `├${"─".repeat(innerWidth)}┤`;
    lines.push(`╭${"─".repeat(innerWidth)}╮`);
    lines.push(row(` ${this.theme.fg("accent", this.theme.bold("Monitor de Tokens"))}  ${this.theme.fg("muted", `· ${VIEW_LABELS[this.view]}`)}`));
    lines.push(separator);
    lines.push(row(this.renderFilters(innerWidth)));
    lines.push(separator);
    const content = this.view === "overview"
      ? this.renderOverview(innerWidth)
      : this.view === "table"
        ? this.renderTable(innerWidth)
        : this.renderLogs(innerWidth);
    const maxPanelRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.90));
    const footerRows = 3;
    const availableBodyRows = Math.max(1, maxPanelRows - lines.length - footerRows);
    const contentOffset = this.getContentOffset(content.length, availableBodyRows);
    const visibleContent = content.slice(contentOffset, contentOffset + availableBodyRows);
    lines.push(...visibleContent.map(row));
    lines.push(separator);
    lines.push(row(this.theme.fg("dim", " Tab modo/filtros  ←→ campo  Enter selecionar  ↑↓ navegar  PgUp/PgDn página  V modo  R atualizar  Esc fechar ")));
    lines.push(`╰${"─".repeat(innerWidth)}╯`);
    return lines.slice(0, maxPanelRows).map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {
    // O painel recalcula as linhas a cada renderização para respeitar o tema atual.
  }

  dispose(): void {}

  private pad(content: string, width: number): string {
    const value = truncateToWidth(content, width, "");
    return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
  }

  private renderFilters(width: number): string {
    const period = this.snapshot.filter.period === "custom"
      ? `${PERIOD_OPTIONS.find((option) => option.id === "custom")?.label} (${new Date(this.snapshot.filter.customFrom ?? 0).toLocaleDateString("pt-BR")} – ${new Date(this.snapshot.filter.customTo ?? 0).toLocaleDateString("pt-BR")})`
      : PERIOD_OPTIONS.find((option) => option.id === this.snapshot.filter.period)?.label ?? this.snapshot.filter.period;
    const router = this.snapshot.filter.router ?? "Todos";
    const model = this.snapshot.filter.model ?? "Todos";
    const fields = [
      this.filterField("Período", period, "period"),
      this.filterField("Router", router, "router"),
      this.filterField("Modelo", model, "model"),
    ];
    return truncateToWidth(` ${fields.join("    ")}`, width, "");
  }

  private filterField(label: string, value: string, focus: FilterFocus): string {
    const color = this.focusArea === "filters" && this.filterFocus === focus ? "accent" : "muted";
    return this.theme.fg(color, `${label}: ${value}`);
  }

  private renderOverview(width: number): string[] {
    const totals = this.snapshot.totals;
    const cards = [
      ["TOTAL GASTO", formatCost(totals.cost)],
      ["REQUISIÇÕES", formatCompact(totals.requests)],
      ["TOKENS GASTOS", formatCompact(totals.freshTokens)],
      ["CACHE HIT", formatPercent(totals.cacheHit)],
    ];
    const cardWidth = Math.max(15, Math.floor((width - 3) / cards.length));
    const cardLine = ` ${cards.map(([label, value]) => this.pad(`${this.theme.fg("muted", label)} ${this.theme.fg("accent", value)}`, cardWidth)).join("│")}`;
    const lines = [cardLine, "", this.theme.fg("accent", this.theme.bold(" DISTRIBUIÇÃO POR ROUTER"))];
    lines.push(...this.renderGroups(this.snapshot.routers, width, 4));
    return lines;
  }

  private renderGroups(groups: UsageGroup[], width: number, limit: number): string[] {
    if (groups.length === 0) return [this.theme.fg("dim", " Nenhum dado no período selecionado.")];
    const nameWidth = Math.max(20, Math.floor(width * 0.45));
    return groups.slice(0, limit).map((group) => {
      const name = this.pad(` ${groupLabel(group)}`, nameWidth);
      const stats = `${formatCompact(group.totals.requests)} req  ${formatCompact(group.totals.freshTokens)} tok  ${formatCost(group.totals.cost)}`;
      return `${name}${this.theme.fg("dim", stats)}`;
    });
  }

  private renderTable(width: number): string[] {
    const lines = [this.theme.fg("accent", this.theme.bold(" MODELOS E ROUTERS"))];
    const header = ` ${this.pad("Modelo", Math.max(24, Math.floor(width * 0.40)))} ${this.pad("Req", 8)} ${this.pad("Tokens", 12)} ${this.pad("Cache", 9)} ${this.pad("Gasto", 11)}`;
    lines.push(this.theme.fg("muted", header));
    lines.push(this.theme.fg("dim", ` ${"─".repeat(Math.min(width, visibleWidth(header)))}`));
    if (this.snapshot.models.length === 0) {
      lines.push(this.theme.fg("dim", " Nenhum dado no período selecionado."));
      return lines;
    }
    const nameWidth = Math.max(24, Math.floor(width * 0.40));
    for (const [index, group] of this.snapshot.models.entries()) {
      const marker = index === this.selectedRow ? "▶" : " ";
      const name = this.pad(` ${marker} ${groupLabel(group)}`, nameWidth);
      lines.push(`${name} ${this.pad(formatCompact(group.totals.requests), 8)} ${this.pad(formatCompact(group.totals.freshTokens), 12)} ${this.pad(formatPercent(group.totals.cacheHit), 9)} ${this.theme.fg("warning", this.pad(formatCost(group.totals.cost), 11))}`);
    }
    return lines;
  }

  private renderLogs(width: number): string[] {
    const records = this.pageRecords();
    const pageCount = Math.max(1, Math.ceil(this.snapshot.records.length / LOG_PAGE_SIZE));
    const lines = [this.theme.fg("accent", this.theme.bold(` LOGS · Página ${this.logsPage + 1}/${pageCount}`))];
    const sessionWidth = Math.max(8, ...records.map((record) => shortSessionId(record.sessionId).length));
    const layout = fitLogColumnWidths(width, sessionWidth);
    const separator = " ".repeat(layout.gap);
    const headerValues = LOG_HEADERS.map((header, index) => index === 0 ? `  ${header}` : header);
    const header = headerValues.map((value, index) => this.pad(value, layout.widths[index]!)).join(separator);
    lines.push(this.theme.fg("muted", ` ${header}`));
    lines.push(this.theme.fg("dim", ` ${"─".repeat(Math.min(width, visibleWidth(header)))}`));
    if (records.length === 0) {
      lines.push(this.theme.fg("dim", " Nenhum log no período selecionado."));
      return lines;
    }
    for (const [index, record] of records.entries()) {
      const data = `${index === this.selectedRow ? "▶" : " "} ${formatLogDate(record.timestamp)}`;
      const values = [
        data,
        record.model,
        record.provider,
        formatCompact(record.totalTokens),
        formatCompact(record.input),
        formatCompact(record.output),
        `${formatCompact(record.cacheRead)}/${formatCompact(record.cacheWrite)}`,
        formatLogCost(record.costTotal),
        shortSessionId(record.sessionId),
      ];
      const line = values.map((value, column) => this.pad(value, layout.widths[column]!)).join(separator);
      lines.push(index === this.selectedRow ? this.theme.fg("accent", ` ${line}`) : ` ${line}`);
    }
    return lines;
  }

  private pageRecords(): UsageRecord[] {
    const start = this.logsPage * LOG_PAGE_SIZE;
    return this.snapshot.records.slice(start, start + LOG_PAGE_SIZE);
  }

  private lastLogsPage(): number {
    return Math.max(0, Math.ceil(this.snapshot.records.length / LOG_PAGE_SIZE) - 1);
  }

  private changeLogsPage(delta: number): void {
    const nextPage = Math.max(0, Math.min(this.lastLogsPage(), this.logsPage + delta));
    if (nextPage === this.logsPage) return;
    this.logsPage = nextPage;
    this.selectedRow = 0;
    this.tui.requestRender();
  }

  private clampSelectedRow(): void {
    const maxRow = this.view === "table" ? this.snapshot.models.length - 1 : this.pageRecords().length - 1;
    this.selectedRow = Math.max(0, Math.min(maxRow, this.selectedRow));
  }

  private getContentOffset(contentLength: number, visibleRows: number): number {
    const itemCount = this.view === "table" ? this.snapshot.models.length : this.pageRecords().length;
    if ((this.view !== "table" && this.view !== "logs") || itemCount === 0) return 0;
    const selectedContentRow = 3 + this.selectedRow;
    return Math.max(0, Math.min(
      Math.max(0, contentLength - visibleRows),
      selectedContentRow - visibleRows + 1,
    ));
  }

  private filterOptions(): readonly FilterOption[] {
    if (this.filterFocus === "period") {
      return PERIOD_OPTIONS.map((option) => ({ value: option.id, label: option.label }));
    }
    const values = this.filterFocus === "router" ? this.snapshot.availableRouters : this.snapshot.availableModels;
    return [{ value: undefined, label: "Todos" }, ...values.map((value) => ({ value, label: value }))];
  }

  private applyFilterSelection(selection: FilterSelection): void {
    const next: TokenMonitorQuery = { ...this.snapshot.filter, now: Date.now() };
    if (this.filterFocus === "period") {
      next.period = selection.value as PeriodPreset;
      if (selection.value === "custom") {
        next.customFrom = selection.customFrom;
        next.customTo = selection.customTo;
      } else {
        delete next.customFrom;
        delete next.customTo;
      }
      delete next.model;
    } else if (this.filterFocus === "router") {
      next.router = selection.value;
      // Modelos disponíveis dependem do período e do router selecionados.
      delete next.model;
    } else {
      next.model = selection.value;
    }
    this.onQueryChange(next);
  }

}
