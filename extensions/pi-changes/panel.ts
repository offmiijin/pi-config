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
import type { ChangedFile, ChangesSnapshot } from "./types.ts";

const METADATA_RATIO = 0.3;
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

function formatNumber(value: number): string {
	return value.toLocaleString("pt-BR");
}

type PanelFocus = "files" | "code";

export class ChangesPanel implements Component {
	private snapshot: ChangesSnapshot;
	private selectedIndex = 0;
	private codeOffset = 0;
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
		const previousFile = this.snapshot.files[this.selectedIndex];
		const selectedPath = previousFile?.path;
		this.snapshot = snapshot;
		const nextIndex = selectedPath
			? snapshot.files.findIndex((file) => file.path === selectedPath)
			: -1;
		this.selectedIndex = nextIndex >= 0
			? nextIndex
			: Math.min(this.selectedIndex, Math.max(0, snapshot.files.length - 1));

		const nextFile = snapshot.files[this.selectedIndex];
		if (!previousFile || !nextFile || previousFile.path !== nextFile.path || previousFile.content !== nextFile.content) {
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

		if (matchesKey(data, Key.enter)) {
			this.focus = this.focus === "files" ? "code" : "files";
			this.tui.requestRender();
		} else if (matchesKey(data, Key.left) && this.focus === "code") {
			this.focus = "files";
			this.tui.requestRender();
		} else if (matchesKey(data, Key.up)) {
			this.focus === "files"
				? this.selectFile(this.selectedIndex - 1)
				: this.scrollCode(-1);
		} else if (matchesKey(data, Key.down)) {
			this.focus === "files"
				? this.selectFile(this.selectedIndex + 1)
				: this.scrollCode(1);
		} else if (this.focus === "code" && matchesKey(data, Key.pageUp)) {
			this.scrollCode(-this.viewportRows());
		} else if (this.focus === "code" && matchesKey(data, Key.pageDown)) {
			this.scrollCode(this.viewportRows());
		} else if (this.focus === "code" && matchesKey(data, Key.home)) {
			this.codeOffset = 0;
			this.tui.requestRender();
		} else if (this.focus === "code" && matchesKey(data, Key.end)) {
			this.codeOffset = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
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
		const file = this.snapshot.files[this.selectedIndex];
		const codeLines = file ? this.renderCodeLines(file, codeWidth) : this.emptyCodeLines(codeWidth);
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

		const footerText = this.focus === "files"
			? " ↑↓ arquivo  Enter código  Alt+D/Esc fechar "
			: " ↑↓ rolar código  PgUp/PgDn  Home/End  ← arquivos  Alt+D/Esc fechar ";
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
		if (this.snapshot.files.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(index, this.snapshot.files.length - 1));
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
		const rawLines = file.content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
		const lineNumberWidth = String(rawLines.length).length;
		return rawLines.map((line, index) => {
			const number = String(index + 1).padStart(lineNumberWidth, " ");
			return truncateToWidth(
				`${this.theme.fg("dim", number)} │ ${this.theme.fg("toolDiffContext", line)}`,
				width,
				"",
			);
		});
	}

	private emptyCodeLines(width: number): string[] {
		if (this.snapshot.error) return [truncateToWidth(this.theme.fg("error", this.snapshot.error), width, "")];
		if (this.snapshot.files.length === 0) {
			return [truncateToWidth(this.theme.fg("dim", "Nenhum arquivo modificado."), width, "")];
		}
		return [truncateToWidth(this.theme.fg("dim", "Selecione um arquivo para ver o código."), width, "")];
	}

	private renderMetadataLines(width: number): string[] {
		if (this.snapshot.files.length === 0) {
			return [this.theme.fg("dim", "Nenhum arquivo")];
		}

		const lines: string[] = [];
		for (let index = 0; index < this.snapshot.files.length; index++) {
			const file = this.snapshot.files[index]!;
			const selected = index === this.selectedIndex;
			const marker = selected ? (this.focus === "files" ? "▶ " : "• ") : "  ";
			const filename = `${marker}${truncatePathFromLeft(file.path, Math.max(1, width - visibleWidth(marker)))}`;
			const nameLine = selected
				? this.theme.bg("selectedBg", padToWidth(filename, width))
				: padToWidth(filename, width);
			const stats = `${file.status} ${this.theme.fg("success", `+${formatNumber(file.additions)}`)} ${this.theme.fg("error", `-${formatNumber(file.deletions)}`)}`;
			lines.push(nameLine, padToWidth(`  ${stats}`, width));
		}
		return lines;
	}
}
