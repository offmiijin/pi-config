import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { MemoryEntry, MemoryQuery, MemoryScopeFilter, MemorySnapshot, MemoryTypeFilter } from "./types.ts";

export const SCOPE_OPTIONS: ReadonlyArray<{ id: MemoryScopeFilter; label: string }> = [
	{ id: "all", label: "Todas" },
	{ id: "global", label: "Globais" },
	{ id: "project", label: "Projeto" },
];

export const TYPE_OPTIONS: ReadonlyArray<{ id: MemoryTypeFilter; label: string }> = [
	{ id: "all", label: "Todos" },
	{ id: "_rules", label: "_rules" },
	{ id: "decisions", label: "decisions" },
	{ id: "gotchas", label: "gotchas" },
	{ id: "lessons", label: "lessons" },
	{ id: "patterns", label: "patterns" },
];

type FocusArea = "filters" | "content";
type FilterFocus = "scope" | "type";
const FILTERS: readonly FilterFocus[] = ["scope", "type"];

function scopeLabel(scope: MemoryScopeFilter): string {
	return SCOPE_OPTIONS.find((o) => o.id === scope)?.label ?? scope;
}

function typeLabel(type: MemoryTypeFilter): string {
	return TYPE_OPTIONS.find((o) => o.id === type)?.label ?? type;
}

function nextOption<T extends string>(options: ReadonlyArray<{ id: T }>, current: T, delta: 1 | -1): T {
	const index = Math.max(0, options.findIndex((o) => o.id === current));
	return options[(index + delta + options.length) % options.length]!.id;
}

export function formatConfidence(value: number): string {
	return value.toFixed(2);
}

export function formatUpdated(value: string): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value.slice(0, 10);
	return date.toLocaleDateString("pt-BR");
}

export interface MemoryPanelCallbacks {
	onQueryChange: (query: MemoryQuery) => void;
	onRefresh: () => void;
	onClose: () => void;
	onPreview: (entry: MemoryEntry) => void;
	onSearch: (current: string) => void;
}

export class MemoryPanel implements Component {
	private snapshot: MemorySnapshot;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly callbacks: MemoryPanelCallbacks;
	private focusArea: FocusArea = "content";
	private filterFocus: FilterFocus = "scope";
	private selectedRow = 0;

	constructor(tui: TUI, theme: Theme, snapshot: MemorySnapshot, callbacks: MemoryPanelCallbacks) {
		this.tui = tui;
		this.theme = theme;
		this.snapshot = snapshot;
		this.callbacks = callbacks;
	}

	setSnapshot(snapshot: MemorySnapshot): void {
		this.snapshot = snapshot;
		this.selectedRow = Math.max(0, Math.min(snapshot.entries.length - 1, this.selectedRow));
		this.tui.requestRender();
	}

	getQuery(): MemoryQuery {
		return { ...this.snapshot.query };
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.alt("m"))) {
			this.callbacks.onClose();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.focusArea = this.focusArea === "content" ? "filters" : "content";
			this.tui.requestRender();
			return;
		}
		if (data === "1" || data === "2" || data === "3") {
			const scope: MemoryScopeFilter = data === "1" ? "all" : data === "2" ? "global" : "project";
			this.emitQuery({ ...this.snapshot.query, scope });
			return;
		}
		if (data === "t" || data === "T") {
			this.emitQuery({ ...this.snapshot.query, type: nextOption(TYPE_OPTIONS, this.snapshot.query.type, 1) });
			return;
		}
		if (data === "/") {
			this.callbacks.onSearch(this.snapshot.query.search);
			return;
		}
		if (data === "r" || data === "R") {
			this.callbacks.onRefresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const entry = this.snapshot.entries[this.selectedRow];
			if (entry && this.focusArea === "content") this.callbacks.onPreview(entry);
			else if (this.focusArea === "filters") this.cycleFocusedFilter(1);
			return;
		}
		// Nos filtros, o movimento lateral alterna o campo focado
		// (Escopo <-> Tipo). Cima/baixo nao trocam de campo.
		if (matchesKey(data, Key.left) || data === "h" || data === "H") {
			if (this.focusArea !== "filters") return;
			this.moveFilterFocus(-1);
			return;
		}
		if (matchesKey(data, Key.right) || data === "l" || data === "L") {
			if (this.focusArea !== "filters") return;
			this.moveFilterFocus(1);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.focusArea === "content") this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.focusArea === "content") this.moveSelection(1);
			return;
		}
	}

	render(width: number): string[] {
		if (width < 52) {
			return [truncateToWidth(this.theme.fg("warning", "Terminal muito estreito para o painel de memórias."), width, "")];
		}
		const innerWidth = width - 2;
		const lines: string[] = [];
		const row = (content: string): string => `│${this.pad(content, innerWidth)}│`;
		const separator = `├${"─".repeat(innerWidth)}┤`;
		lines.push(`╭${"─".repeat(innerWidth)}╮`);
		lines.push(row(` ${this.theme.fg("accent", this.theme.bold("Monitor de Memórias"))}  ${this.theme.fg("muted", `· ${this.snapshot.projectId}`)}`));
		lines.push(separator);
		lines.push(row(this.renderFilters(innerWidth)));
		lines.push(separator);
		const body = this.renderBody(innerWidth);
		const maxPanelRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.9));
		const availableBodyRows = Math.max(1, maxPanelRows - lines.length - 3);
		const offset = this.getContentOffset(body.length, availableBodyRows);
		lines.push(...body.slice(offset, offset + availableBodyRows).map(row));
		lines.push(separator);
		lines.push(row(this.theme.fg("dim", " Tab filtros/lista  ←→/h/l campo  Enter valor  T tipo  / buscar  R atualizar  Esc fechar ")));
		lines.push(`╰${"─".repeat(innerWidth)}╯`);
		return lines.slice(0, maxPanelRows).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
	dispose(): void {}

	private emitQuery(query: MemoryQuery): void {
		this.selectedRow = 0;
		this.callbacks.onQueryChange(query);
	}

	private cycleFocusedFilter(delta: 1 | -1): void {
		const query = this.snapshot.query;
		if (this.filterFocus === "scope") this.emitQuery({ ...query, scope: nextOption(SCOPE_OPTIONS, query.scope, delta) });
		else this.emitQuery({ ...query, type: nextOption(TYPE_OPTIONS, query.type, delta) });
	}

	private moveFilterFocus(delta: 1 | -1): void {
		this.filterFocus = FILTERS[(FILTERS.indexOf(this.filterFocus) + delta + FILTERS.length) % FILTERS.length]!;
		this.tui.requestRender();
	}

	private moveSelection(delta: 1 | -1): void {
		if (this.snapshot.entries.length === 0) return;
		this.selectedRow = Math.max(0, Math.min(this.snapshot.entries.length - 1, this.selectedRow + delta));
		this.tui.requestRender();
	}

	private getContentOffset(contentLength: number, visibleRows: number): number {
		if (this.snapshot.entries.length === 0) return 0;
		const selectedContentRow = 2 + this.selectedRow;
		return Math.max(0, Math.min(Math.max(0, contentLength - visibleRows), selectedContentRow - visibleRows + 1));
	}

	private pad(content: string, width: number): string {
		const value = truncateToWidth(content, width, "");
		return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
	}

	private filterField(label: string, value: string, focus: FilterFocus): string {
		const color = this.focusArea === "filters" && this.filterFocus === focus ? "accent" : "muted";
		return this.theme.fg(color, `${label}: ${value}`);
	}

	private renderFilters(width: number): string {
		const { scope, type, search } = this.snapshot.query;
		const parts = [
			this.filterField("Escopo", scopeLabel(scope), "scope"),
			this.filterField("Tipo", typeLabel(type), "type"),
			this.theme.fg("muted", `Buscar: ${search ? search : "—"}`),
			this.theme.fg("dim", `[G ${this.snapshot.totals.global} · P ${this.snapshot.totals.project}]`),
		];
		return truncateToWidth(` ${parts.join("   ")}`, width, "");
	}

	private renderBody(width: number): string[] {
		if (this.snapshot.entries.length === 0) {
			return [
				this.theme.fg("dim", " Nenhuma memória encontrada."),
				this.theme.fg("dim", " Gere com memory_save ou aguarde a extração automática."),
			];
		}
		// Linha: `␣▸␣ ESCOPO(8) ␣ TIPO(10) ␣ NOME(N) ␣ CONF(6) ␣ DATA(10)` = 41 + N.
		// O cabeçalho reserva o mesmo prefixo de 3 cols do marcador para as
		// colunas de dados caírem exatamente sob os títulos. Cada célula é
		// truncada na largura da coluna ANTES do pad, então nomes longos são
		// cortados antes de alcançar Conf/Atual.
		const nameWidth = Math.max(10, width - 41);
		const header = `   ${this.pad("Escopo", 8)} ${this.pad("Tipo", 10)} ${this.pad("Memória", nameWidth)} ${this.pad("Conf", 6)} ${this.pad("Atual.", 10)}`;
		const lines = [this.theme.fg("muted", truncateToWidth(header, width, ""))];
		for (const [index, entry] of this.snapshot.entries.entries()) {
			const marker = index === this.selectedRow && this.focusArea === "content" ? "▶" : " ";
			const scope = truncateToWidth(entry.scope === "global" ? "GLOBAL" : "PROJETO", 8, "");
			const type = truncateToWidth(entry.type, 10, "");
			const name = truncateToWidth(`${entry.context} — ${entry.title}`, nameWidth, "");
			const conf = truncateToWidth(formatConfidence(entry.confidence), 6, "");
			const updated = truncateToWidth(formatUpdated(entry.updated), 10, "");
			const line = ` ${marker} ${this.pad(scope, 8)} ${this.pad(type, 10)} ${this.pad(name, nameWidth)} ${this.pad(conf, 6)} ${this.pad(updated, 10)}`;
			lines.push(index === this.selectedRow ? this.theme.fg("accent", truncateToWidth(line, width, "")) : truncateToWidth(line, width, ""));
		}
		return lines;
	}
}

export class MemoryDetailsPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly entry: MemoryEntry;
	private readonly preview: string;
	private readonly onClose: () => void;
	private scroll = 0;

	constructor(tui: TUI, theme: Theme, entry: MemoryEntry, preview: string, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.entry = entry;
		this.preview = preview;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.alt("m"))) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			this.scroll = this.scroll + 1;
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const row = (content: string): string => `│${this.pad(content, innerWidth)}│`;
		const separator = `├${"─".repeat(innerWidth)}┤`;
		const header = [
			`╭${"─".repeat(innerWidth)}╮`,
			row(this.theme.fg("accent", this.theme.bold(` ${this.entry.scope === "global" ? "GLOBAL" : "PROJETO"} · ${this.entry.type}/${this.entry.context}`))),
			row(this.theme.fg("muted", ` ${this.entry.title} · conf ${formatConfidence(this.entry.confidence)} · ${formatUpdated(this.entry.updated)}`)),
			row(this.theme.fg("dim", ` ${this.entry.path}`)),
			separator,
		];
		const footer = [
			separator,
			row(this.theme.fg("dim", " ↑↓/j/k rolar  Esc fechar ")),
			`╰${"─".repeat(innerWidth)}╯`,
		];
		// Quebra por palavra: nada do conteúdo é descartado — o excedente
		// desce para a linha visual seguinte (palavras longas demais quebram
		// forçado, sem outro jeito). A rolagem anda sobre linhas visuais.
		const contentWidth = Math.max(1, innerWidth - 1);
		const visual = wrapTextWithAnsi(this.preview, contentWidth).map((line) => row(` ${line}`));
		const maxPanelRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.9));
		const availableBodyRows = Math.max(1, maxPanelRows - header.length - footer.length);
		this.scroll = Math.max(0, Math.min(Math.max(0, visual.length - availableBodyRows), this.scroll));
		const visible = visual.slice(this.scroll, this.scroll + availableBodyRows);
		return [...header, ...visible, ...footer].slice(0, maxPanelRows).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
	dispose(): void {}

	private pad(content: string, width: number): string {
		const value = truncateToWidth(content, width, "");
		return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
	}
}
