import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type TUI,
	type Component,
} from "@earendil-works/pi-tui";
import type { ChangedFile, ChangeGroup, ChangesSnapshot, LineRange } from "./types.ts";

const METADATA_RATIO = 0.3;
const FILE_CONTEXT_LINES = 10;
// TESTE MANUAL: região superior para validar o contexto do arquivo.
const MIN_PANEL_WIDTH = 32;

/** Mantém o sufixo do caminho, útil para distinguir arquivos em pastas profundas. */
export function truncatePathFromLeft(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;
	if (width === 1) return "…";

	const suffixWidth = width - 1;
	const start = Math.max(0, visibleWidth(path) - suffixWidth);
	return `…${sliceByColumn(path, start, suffixWidth, true)}`;
}

function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width), "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function statusColor(status: ChangedFile["status"]): "success" | "error" | "warning" | "accent" | "muted" {
	switch (status) {
		case "A": return "success";
		case "D": return "error";
		case "?": return "warning";
		case "R":
		case "C": return "accent";
		default: return "muted";
	}
}

function diffLineColor(line: string): "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "accent" | "dim" {
	if (line.startsWith("+") && !line.startsWith("+++")) return "toolDiffAdded";
	if (line.startsWith("-") && !line.startsWith("---")) return "toolDiffRemoved";
	if (line.startsWith("@@")) return "accent";
	if (
		line.startsWith("diff --git ") ||
		line.startsWith("index ") ||
		line.startsWith("---") ||
		line.startsWith("+++")
	) return "dim";
	return "toolDiffContext";
}

function formatNumber(value: number): string {
	return value.toLocaleString("pt-BR");
}

function mergeLineRanges(ranges: LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function contextRanges(ranges: LineRange[], totalLines: number): LineRange[] {
	if (totalLines <= 0 || ranges.length === 0) return [{ start: 1, end: Math.max(1, totalLines) }];
	return mergeLineRanges(ranges.map((range) => ({
		start: Math.max(1, range.start - FILE_CONTEXT_LINES),
		end: Math.min(totalLines, range.end + FILE_CONTEXT_LINES),
	})));
}

function lineIsInRange(line: number, ranges: LineRange[]): boolean {
	return ranges.some((range) => line >= range.start && line <= range.end);
}

type PanelFocus = "files" | "code";

interface FileSelection {
	group: ChangeGroup;
	file: ChangedFile;
}

function fileSelections(snapshot: ChangesSnapshot): FileSelection[] {
	return snapshot.groups.flatMap((group) => group.files.map((file) => ({ group, file })));
}

function selectionKey(selection: FileSelection | undefined): string | undefined {
	return selection ? `${selection.group.id}\0${selection.file.path}` : undefined;
}

export class ChangesPanel implements Component {
	private snapshot: ChangesSnapshot;
	private selectedIndex = 0;
	private codeOffset = 0;
	private showFullFile = false;
	private focus: PanelFocus = "files";
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onClose: () => void;

	constructor(tui: TUI, theme: Theme, snapshot: ChangesSnapshot, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.snapshot = snapshot;
		this.onClose = onClose;
	}

	setSnapshot(snapshot: ChangesSnapshot): void {
		const previousSelection = fileSelections(this.snapshot)[this.selectedIndex];
		const previousKey = selectionKey(previousSelection);
		this.snapshot = snapshot;
		const nextSelections = fileSelections(snapshot);
		const nextIndex = previousKey
			? nextSelections.findIndex((selection) => selectionKey(selection) === previousKey)
			: -1;
		this.selectedIndex = nextIndex >= 0
			? nextIndex
			: Math.min(this.selectedIndex, Math.max(0, nextSelections.length - 1));

		const nextSelection = nextSelections[this.selectedIndex];
		if (
			!previousSelection ||
			!nextSelection ||
			selectionKey(previousSelection) !== selectionKey(nextSelection) ||
			previousSelection.file.diff !== nextSelection.file.diff ||
			previousSelection.file.content !== nextSelection.file.content
		) {
			this.codeOffset = 0;
		}
		this.tui.requestRender();
	}

	close(): void {
		this.onClose();
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, Key.alt("d"))
		) {
			this.close();
			return;
		}

		const moveUp = matchesKey(data, Key.up) || matchesKey(data, "k") || data === "K";
		const moveDown = matchesKey(data, Key.down) || matchesKey(data, "j") || data === "J";
		if (data === "f" || data === "F") {
			this.showFullFile = !this.showFullFile;
			this.codeOffset = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			this.focus = this.focus === "files" ? "code" : "files";
			this.tui.requestRender();
		} else if (matchesKey(data, Key.left) && this.focus === "code") {
			this.focus = "files";
			this.tui.requestRender();
		} else if (moveUp) {
			this.focus === "files"
				? this.selectFile(this.selectedIndex - 1)
				: this.scrollCode(-1);
		} else if (moveDown) {
			this.focus === "files"
				? this.selectFile(this.selectedIndex + 1)
				: this.scrollCode(1);
		}
	}

	render(width: number): string[] {
		if (width < MIN_PANEL_WIDTH) {
			return [truncateToWidth(this.theme.fg("warning", "Janela muito estreita para o painel de alterações."), width)];
		}

		const innerWidth = width - 2;
		const metadataWidth = Math.max(18, Math.floor(innerWidth * METADATA_RATIO));
		const codeWidth = Math.max(1, innerWidth - metadataWidth - 1);
		const viewportRows = this.viewportRows();
		const selection = fileSelections(this.snapshot)[this.selectedIndex];
		const codeLines = selection ? this.renderCodeLines(selection.file, codeWidth) : this.emptyCodeLines(codeWidth);
		const metadataLines = this.renderMetadataLines(metadataWidth);
		const bodyRows = Math.max(1, Math.min(viewportRows, Math.max(codeLines.length, metadataLines.length)));
		const maxOffset = Math.max(0, codeLines.length - bodyRows);
		const codeStart = Math.min(this.codeOffset, maxOffset);
		this.codeOffset = codeStart;

		const title = this.snapshot.error
			? this.theme.fg("error", "Alterações — Git indisponível")
			: this.theme.fg("accent", this.theme.bold(
				`Alterações  +${formatNumber(this.snapshot.totalAdditions)} -${formatNumber(this.snapshot.totalDeletions)}`,
			));
		const contentRow = (content: string): string =>
			`│${padToWidth(content, innerWidth)}│`;
		const horizontalRow = (left: string, right: string): string =>
			`${left}${"─".repeat(innerWidth)}${right}`;
		// A haste vertical da divisória começa abaixo do cabeçalho; `┬` evita desenhá-la dentro do título.
		const separator = `├${"─".repeat(codeWidth)}┬${"─".repeat(metadataWidth)}┤`;
		const lines = [
			horizontalRow("╭", "╮"),
			contentRow(` ${title}`),
			separator,
		];

		for (let row = 0; row < bodyRows; row++) {
			const codeLine = codeLines[codeStart + row] ?? "";
			const metadataLine = metadataLines[row] ?? "";
			lines.push(`│${padToWidth(codeLine, codeWidth)}│${padToWidth(metadataLine, metadataWidth)}│`);
		}

		// TESTE MANUAL: região inferior para validar a separação entre trechos.
		const footerText = this.focus === "files"
			? ` ↑↓ K↑ J↓ arquivo  Enter arquivo  F ${this.showFullFile ? "contexto" : "arquivo completo"}  Alt+D/Esc fechar `
			: ` ↑↓ K↑ J↓ rolar arquivo  ← arquivos  F ${this.showFullFile ? "contexto" : "arquivo completo"}  Alt+D/Esc fechar `;
		const footer = this.theme.fg("dim", footerText);
		lines.push(contentRow(footer));
		lines.push(horizontalRow("╰", "╯"));
		return lines;
	}

	invalidate(): void {
		// O painel não mantém cache de strings renderizadas.
	}

	dispose(): void {
		// Reservado para futuras fontes de atualização do painel.
	}

	private selectFile(index: number): void {
		const selections = fileSelections(this.snapshot);
		if (selections.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(index, selections.length - 1));
		this.codeOffset = 0;
		this.tui.requestRender();
	}

	private scrollCode(delta: number): void {
		this.codeOffset = Math.max(0, this.codeOffset + delta);
		this.tui.requestRender();
	}

	private viewportRows(): number {
		return Math.max(3, Math.floor(this.tui.terminal.rows * 0.9) - 6);
	}

	private renderCodeLines(file: ChangedFile, width: number): string[] {
		if (file.content === undefined) return this.renderDiffLines(file, width);

		const rawLines = file.content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
		const totalLines = rawLines.length;
		const ranges = this.showFullFile
			? [{ start: 1, end: totalLines }]
			: contextRanges(file.changedLineRanges, totalLines);
		const lineNumberWidth = String(totalLines).length;
		const lines: string[] = [];
		let previousEnd = 0;

		for (const range of ranges) {
			if (range.start > previousEnd + 1) {
				lines.push(this.theme.fg("dim", "      …"));
			}
			for (let lineNumber = range.start; lineNumber <= range.end; lineNumber++) {
				const sourceLine = rawLines[lineNumber - 1] ?? "";
				const number = String(lineNumber).padStart(lineNumberWidth, " ");
				const color = lineIsInRange(lineNumber, file.changedLineRanges)
					? "toolDiffAdded"
					: "toolDiffContext";
				lines.push(truncateToWidth(
					`${this.theme.fg("dim", number)} │ ${this.theme.fg(color, sourceLine)}`,
					width,
					"",
				));
			}
			previousEnd = range.end;
		}
		if (!this.showFullFile && previousEnd < totalLines) lines.push(this.theme.fg("dim", "      …"));
		return lines;
	}

	private renderDiffLines(file: ChangedFile, width: number): string[] {
		const rawLines = file.diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
		return rawLines.map((line) => truncateToWidth(
			this.theme.fg(diffLineColor(line), line),
			width,
			"",
		));
	}

	private emptyCodeLines(width: number): string[] {
		if (this.snapshot.error) return [truncateToWidth(this.theme.fg("error", this.snapshot.error), width, "")];
		if (fileSelections(this.snapshot).length === 0) {
			return [truncateToWidth(this.theme.fg("dim", "Nenhuma alteração desde o início da sessão."), width, "")];
		}
		return [truncateToWidth(this.theme.fg("dim", "Selecione um arquivo para ver o arquivo."), width, "")];
	}

	private renderMetadataLines(width: number): string[] {
		if (fileSelections(this.snapshot).length === 0) {
			return [this.theme.fg("dim", "Nenhum arquivo")];
		}

		const lines: string[] = [];
		let fileIndex = 0;
		for (const group of this.snapshot.groups) {
			const groupColor = group.kind === "commit" ? "accent" : "warning";
			lines.push(padToWidth(this.theme.fg(groupColor, ` ${group.label}`), width));
			for (const file of group.files) {
				const selected = fileIndex === this.selectedIndex;
				const marker = selected ? (this.focus === "files" ? "▶ " : "• ") : "  ";
				const filename = `${marker}${truncatePathFromLeft(file.path, Math.max(1, width - visibleWidth(marker)))}`;
				const nameLine = selected
					? this.theme.bg("selectedBg", padToWidth(filename, width))
					: padToWidth(filename, width);
				const status = this.theme.fg(statusColor(file.status), file.status);
				const stats = `${status} ${this.theme.fg("success", `+${formatNumber(file.additions)}`)} ${this.theme.fg("error", `-${formatNumber(file.deletions)}`)}`;
				lines.push(nameLine, padToWidth(`  ${stats}`, width));
				fileIndex++;
			}
		}
		return lines;
	}
}
