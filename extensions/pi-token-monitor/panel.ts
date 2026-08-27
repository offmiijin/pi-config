import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { PeriodPreset, TokenMonitorView, UsageFilter, UsageGroup, UsageRecord, UsageSnapshot, UsageTotals } from "./types.ts";

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

const VIEWS: readonly TokenMonitorView[] = ["overview", "table", "graphs", "details"];
const VIEW_LABELS: Record<TokenMonitorView, string> = {
  overview: "Resumo",
  table: "Tabela",
  graphs: "Gráficos",
  details: "Detalhes",
};
const FILTERS = ["period", "router", "model"] as const;
type FilterFocus = typeof FILTERS[number];
type GraphMetric = "cost" | "freshTokens" | "requests";

function formatCompact(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString("pt-BR");
}

function formatCost(value: number): string {
  return `$${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/d" : `${(value * 100).toFixed(1)}%`;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    freshTokens: 0,
    cost: 0,
    cacheHit: null,
  };
}

function groupLabel(group: UsageGroup): string {
  return group.label.length > 38 ? `${group.label.slice(0, 35)}...` : group.label;
}

function metricValue(totals: UsageTotals, metric: GraphMetric): number {
  if (metric === "cost") return totals.cost;
  if (metric === "requests") return totals.requests;
  return totals.freshTokens;
}

function metricLabel(metric: GraphMetric): string {
  if (metric === "cost") return "Custo";
  if (metric === "requests") return "Requisições";
  return "Tokens frescos";
}

function sampleValues(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  return Array.from({ length: width }, (_, index) => values[Math.floor(index * values.length / width)] ?? 0);
}

function sparkline(values: number[], width: number): string {
  if (width <= 0) return "";
  const marks = "▁▂▃▄▅▆▇█";
  const sampled = sampleValues(values, width);
  if (sampled.length === 0 || sampled.every((value) => value === 0)) return "·".repeat(Math.min(width, 24));
  const max = Math.max(...sampled, 1);
  return sampled.map((value) => marks[Math.min(marks.length - 1, Math.round((value / max) * (marks.length - 1)))]).join("");
}

export interface TokenMonitorQuery extends UsageFilter {
  now?: number;
}

export type CustomPeriodCallback = () => Promise<{ from: number; to: number } | null>;

export class TokenMonitorPanel implements Component {
  private snapshot: UsageSnapshot;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly onQueryChange: (query: TokenMonitorQuery) => void;
  private readonly onRefresh: () => void;
  private readonly onCustomPeriod?: CustomPeriodCallback;
  private view: TokenMonitorView = "overview";
  private filterFocus: FilterFocus = "period";
  private selectedRow = 0;
  private graphMetric: GraphMetric = "cost";

  constructor(
    tui: TUI,
    theme: Theme,
    snapshot: UsageSnapshot,
    onQueryChange: (query: TokenMonitorQuery) => void,
    onRefresh: () => void,
    onClose: () => void,
    onCustomPeriod?: CustomPeriodCallback,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.snapshot = snapshot;
    this.onQueryChange = onQueryChange;
    this.onRefresh = onRefresh;
    this.onClose = onClose;
    this.onCustomPeriod = onCustomPeriod;
  }

  setSnapshot(snapshot: UsageSnapshot): void {
    this.snapshot = snapshot;
    this.selectedRow = Math.min(this.selectedRow, Math.max(0, snapshot.records.length - 1));
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
      this.filterFocus = FILTERS[(FILTERS.indexOf(this.filterFocus) + 1) % FILTERS.length]!;
      this.tui.requestRender();
      return;
    }
    if (data === "v") {
      this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!;
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.graphMetric = this.graphMetric === "cost" ? "freshTokens" : this.graphMetric === "freshTokens" ? "requests" : "cost";
      this.view = "graphs";
      this.tui.requestRender();
      return;
    }
    if (data === "r") {
      this.onRefresh();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
      this.changeFilter(-1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
      if (this.view === "table" || this.view === "details") {
        this.selectedRow = Math.min(this.snapshot.records.length - 1, this.selectedRow + 1);
        this.tui.requestRender();
      } else {
        this.changeFilter(1);
      }
      return;
    }
    if (data === "j" || data === "J") {
      this.selectedRow = Math.min(this.snapshot.records.length - 1, this.selectedRow + 1);
      this.tui.requestRender();
    } else if (data === "k" || data === "K") {
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
        : this.view === "graphs"
          ? this.renderGraphs(innerWidth)
          : this.renderDetails(innerWidth);
    const targetRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.96));
    const footerRows = 3;
    const availableBodyRows = Math.max(1, targetRows - lines.length - footerRows);
    lines.push(...content.slice(0, availableBodyRows).map(row));
    while (lines.length < targetRows - footerRows) lines.push(row(""));
    lines.push(separator);
    lines.push(row(this.theme.fg("dim", " Tab filtros  ↑↓ navegar  V modo  G gráfico  R atualizar  Alt+M/Esc fechar ")));
    lines.push(`╰${"─".repeat(innerWidth)}╯`);
    return lines.slice(0, targetRows).map((line) => truncateToWidth(line, width, ""));
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
    return truncateToWidth(fields.join("    "), width, "");
  }

  private filterField(label: string, value: string, focus: FilterFocus): string {
    const color = this.filterFocus === focus ? "accent" : "muted";
    return this.theme.fg(color, `${label}: ${value}`);
  }

  private renderOverview(width: number): string[] {
    const totals = this.snapshot.totals;
    const cards = [
      ["TOTAL GASTO", formatCost(totals.cost)],
      ["REQUISIÇÕES", formatCompact(totals.requests)],
      ["TOKENS FRESCOS", formatCompact(totals.freshTokens)],
      ["CACHE HIT", formatPercent(totals.cacheHit)],
    ];
    const cardWidth = Math.max(15, Math.floor((width - 3) / cards.length));
    const cardLine = cards.map(([label, value]) => this.pad(`${this.theme.fg("muted", label)} ${this.theme.fg("accent", value)}`, cardWidth)).join("│");
    const lines = [cardLine, "", this.theme.fg("accent", this.theme.bold(` CONSUMO POR TEMPO · ${metricLabel(this.graphMetric)}`))];
    lines.push(...this.renderMiniGraph(width));
    lines.push("", this.theme.fg("accent", this.theme.bold(" DISTRIBUIÇÃO POR ROUTER")));
    lines.push(...this.renderGroups(this.snapshot.routers, width, 4));
    return lines;
  }

  private renderMiniGraph(width: number): string[] {
    const values = this.snapshot.buckets.map((bucket) => metricValue(bucket.totals, this.graphMetric));
    return this.renderChart(values, 4, width);
  }

  private renderChart(values: number[], height: number, width: number): string[] {
    const chartWidth = Math.max(24, width - 11);
    const sampled = sampleValues(values, chartWidth);
    const max = Math.max(...sampled, 1);
    const lines: string[] = [];
    for (let row = height; row > 0; row--) {
      const threshold = max * row / height;
      const bars = sampled.map((value) => value >= threshold ? "█" : " ").join("");
      const axis = metricValue({ ...emptyTotals(), cost: threshold, freshTokens: threshold, requests: threshold }, this.graphMetric);
      lines.push(` ${this.theme.fg("dim", this.pad(this.graphMetric === "cost" ? formatCost(axis) : formatCompact(axis), 7))} ${this.theme.fg("dim", "│")} ${this.theme.fg("success", bars)}`);
    }
    lines.push(` ${this.theme.fg("dim", "       └" + "─".repeat(chartWidth))}`);
    const labels = this.axisLabels(chartWidth);
    lines.push(` ${this.theme.fg("dim", "        " + labels)}`);
    return lines;
  }

  private axisLabels(width: number): string {
    const buckets = this.snapshot.buckets;
    if (buckets.length === 0) return "";
    const count = Math.min(7, buckets.length);
    const labels = Array.from({ length: count }, (_, index) => {
      const bucket = buckets[Math.floor(index * (buckets.length - 1) / Math.max(1, count - 1))]!;
      return bucket.label;
    });
    return truncateToWidth(labels.join("   "), width, "");
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
    const header = `${this.pad("Modelo", Math.max(24, Math.floor(width * 0.40)))} ${this.pad("Req", 8)} ${this.pad("Tokens", 12)} ${this.pad("Cache", 9)} ${this.pad("Gasto", 11)}`;
    lines.push(this.theme.fg("muted", header));
    lines.push(this.theme.fg("dim", "─".repeat(Math.min(width, visibleWidth(header)))));
    if (this.snapshot.models.length === 0) {
      lines.push(this.theme.fg("dim", "Nenhum dado no período selecionado."));
      return lines;
    }
    const nameWidth = Math.max(24, Math.floor(width * 0.40));
    for (const [index, group] of this.snapshot.models.entries()) {
      const marker = index === this.selectedRow ? "▶" : " ";
      const name = this.pad(`${marker} ${groupLabel(group)}`, nameWidth);
      lines.push(`${name} ${this.pad(formatCompact(group.totals.requests), 8)} ${this.pad(formatCompact(group.totals.freshTokens), 12)} ${this.pad(formatPercent(group.totals.cacheHit), 9)} ${this.theme.fg("warning", this.pad(formatCost(group.totals.cost), 11))}`);
    }
    return lines;
  }

  private renderGraphs(width: number): string[] {
    const lines = [this.theme.fg("accent", this.theme.bold(` GRÁFICOS · ${metricLabel(this.graphMetric)}`))];
    const values = this.snapshot.buckets.map((bucket) => metricValue(bucket.totals, this.graphMetric));
    lines.push(this.theme.fg("dim", "Escala vertical automática · cada coluna representa um intervalo do período."));
    lines.push(...this.renderChart(values, 8, width));
    lines.push("");
    for (const group of this.snapshot.models.slice(0, 6)) {
      const groupValues = this.snapshot.buckets.map((bucket, index) => {
        const nextStart = this.snapshot.buckets[index + 1]?.start ?? this.snapshot.to;
        const bucketRecords = this.snapshot.records.filter((record) =>
          record.model === group.key && record.timestamp >= bucket.start && record.timestamp < nextStart,
        );
        const bucketTotals = bucketRecords.reduce((totals, record) => {
          totals.requests += 1;
          totals.freshTokens += record.input + record.output + record.cacheWrite;
          totals.cost += record.costTotal;
          return totals;
        }, { ...emptyTotals() });
        return metricValue(bucketTotals, this.graphMetric);
      });
      lines.push(`${this.pad(groupLabel(group), 28)} ${this.theme.fg("accent", sparkline(groupValues, Math.max(20, width - 38)))}`);
    }
    if (this.snapshot.models.length === 0) lines.push(this.theme.fg("dim", "Nenhum dado para desenhar."));
    return lines;
  }

  private renderDetails(width: number): string[] {
    const record = this.snapshot.records[this.selectedRow];
    if (!record) return [this.theme.fg("dim", "Nenhuma requisição no período selecionado.")];
    const lines = [this.theme.fg("accent", this.theme.bold(" DETALHES DA REQUISIÇÃO"))];
    const fields: Array<[string, string]> = [
      ["Data", new Date(record.timestamp).toLocaleString("pt-BR")],
      ["Router", record.provider],
      ["Modelo", record.model],
      ["Modelo respondido", record.responseModel ?? "não informado"],
      ["Entrada", formatCompact(record.input)],
      ["Saída", formatCompact(record.output)],
      ["Cache read/write", `${formatCompact(record.cacheRead)} / ${formatCompact(record.cacheWrite)}`],
      ["Total de tokens", formatCompact(record.totalTokens)],
      ["Custo", formatCost(record.costTotal)],
      ["Sessão", record.sessionId],
    ];
    for (const [label, value] of fields) lines.push(`${this.theme.fg("muted", this.pad(`${label}:`, 22))} ${truncateToWidth(value, Math.max(1, width - 24), "")}`);
    return lines;
  }

  private changeFilter(delta: number): void {
    if (this.filterFocus === "period") {
      const current = Math.max(0, PERIOD_OPTIONS.findIndex((option) => option.id === this.snapshot.filter.period));
      const next = PERIOD_OPTIONS[(current + delta + PERIOD_OPTIONS.length) % PERIOD_OPTIONS.length]!;
      if (next.id === "custom" && this.onCustomPeriod) {
        void this.onCustomPeriod().then((range) => {
          if (!range) return;
          this.onQueryChange({ ...this.snapshot.filter, period: "custom", customFrom: range.from, customTo: range.to, now: Date.now() });
        });
      } else {
        this.onQueryChange({ ...this.snapshot.filter, period: next.id, now: Date.now() });
      }
      return;
    }
    const groups = this.filterFocus === "router" ? this.snapshot.routers : this.snapshot.models;
    const values = groups.map((group) => group.key);
    const currentValue = this.filterFocus === "router" ? this.snapshot.filter.router : this.snapshot.filter.model;
    const current = currentValue ? values.indexOf(currentValue) : -1;
    const nextValue = current + delta < 0 || current + delta >= values.length ? undefined : values[current + delta];
    const next: TokenMonitorQuery = { ...this.snapshot.filter, now: Date.now() };
    if (this.filterFocus === "router") next.router = nextValue;
    else next.model = nextValue;
    this.onQueryChange(next);
  }
}
