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
const MIN_PANEL_WIDTH = 32;

interface ChangeTotals {
	additions: number;
	deletions: number;
}

function totalsForFiles(files: readonly ChangedFile[]): ChangeTotals {
	return files.reduce(
		(totals, file) => ({
			additions: totals.additions + file.additions,
			deletions: totals.deletions + file.deletions,
		}),
		{ additions: 0, deletions: 0 },
	);
}

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

interface HunkPosition {
	oldLine: number;
	newLine: number;
}

function parseHunkPosition(line: string): HunkPosition | undefined {
	const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	return header
		? { oldLine: Number(header[1]), newLine: Number(header[2]) }
		: undefined;
}

interface RemovedLine {
	lineNumber: number;
	position: number;
	content: string;
}

function parseRemovedLines(diff: string): RemovedLine[] {
	const removed: RemovedLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		const hunk = parseHunkPosition(line);
		if (hunk) {
			oldLine = hunk.oldLine;
			newLine = hunk.newLine;
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;

		if (line.startsWith("-") && !line.startsWith("--- ")) {
			removed.push({
				lineNumber: oldLine,
				position: Math.max(1, newLine),
				content: line.slice(1),
			});
			oldLine++;
		} else if (line.startsWith("+") && !line.startsWith("+++ ")) {
			newLine++;
		} else if (line.startsWith(" ")) {
			oldLine++;
			newLine++;
		} else if (!line.startsWith("\\")) {
			oldLine++;
			newLine++;
		}
	}
	return removed;
}

function lineIsInRange(line: number, ranges: LineRange[]): boolean {
	return ranges.some((range) => line >= range.start && line <= range.end);
}

type PanelFocus = "files" | "code";

interface FileSelection {
	group: ChangeGroup;
	file: ChangedFile;
}

type PanelItem =
	| { kind: "commit"; group: ChangeGroup }
	| { kind: "file"; group: ChangeGroup; file: ChangedFile };

interface MetadataRender {
	lines: string[];
	selectedRange?: LineRange;
}

function panelItems(snapshot: ChangesSnapshot, expandedCommits: Set<string>): PanelItem[] {
	return snapshot.groups.flatMap((group) => {
		if (group.kind === "working-tree") {
			return group.files.map((file) => ({ kind: "file" as const, group, file }));
		}
		const items: PanelItem[] = [{ kind: "commit", group }];
		if (expandedCommits.has(group.id)) {
			items.push(...group.files.map((file) => ({ kind: "file" as const, group, file })));
		}
		return items;
	});
}

function itemKey(item: PanelItem | undefined): string | undefined {
	if (!item) return undefined;
	return item.kind === "commit" ? `commit:${item.group.id}` : `${item.group.id}\0${item.file.path}`;
}

function fileSelection(item: PanelItem | undefined): FileSelection | undefined {
	return item?.kind === "file" ? { group: item.group, file: item.file } : undefined;
}

export class ChangesPanel implements Component {
	private snapshot: ChangesSnapshot;
	private selectedIndex = 0;
	private metadataOffset = 0;
	private codeOffset = 0;
	private showFullFile = false;
	private readonly expandedCommits = new Set<string>();
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
		const previousItem = panelItems(this.snapshot, this.expandedCommits)[this.selectedIndex];
		const previousFile = fileSelection(previousItem);
		const previousKey = itemKey(previousItem);
		this.snapshot = snapshot;
		const nextItems = panelItems(snapshot, this.expandedCommits);
		const nextIndex = previousKey
			? nextItems.findIndex((item) => itemKey(item) === previousKey)
			: -1;
		this.selectedIndex = nextIndex >= 0
			? nextIndex
			: Math.min(this.selectedIndex, Math.max(0, nextItems.length - 1));

		const nextFile = fileSelection(nextItems[this.selectedIndex]);
		if (
			!previousFile ||
			!nextFile ||
			previousFile.group.id !== nextFile.group.id ||
			previousFile.file.path !== nextFile.file.path ||
			previousFile.file.diff !== nextFile.file.diff ||
			previousFile.file.content !== nextFile.file.content
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
			if (this.focus === "files") {
				const item = this.selectedItem();
				if (item?.kind === "commit") {
					this.toggleCommit(item.group.id);
				} else {
					this.focus = "code";
					this.tui.requestRender();
				}
			} else {
				this.focus = "files";
				this.tui.requestRender();
			}
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
		const selectedItem = this.selectedItem();
		const selection = fileSelection(selectedItem);
		const codeLines = selection ? this.renderCodeLines(selection.file, codeWidth) : this.emptyCodeLines(codeWidth);
		const metadata = this.renderMetadataLines(metadataWidth);
		const bodyRows = Math.max(1, Math.min(viewportRows, Math.max(codeLines.length, metadata.lines.length)));
		const maxCodeOffset = Math.max(0, codeLines.length - bodyRows);
		const codeStart = Math.min(this.codeOffset, maxCodeOffset);
		this.codeOffset = codeStart;
		const maxMetadataOffset = Math.max(0, metadata.lines.length - bodyRows);
		this.metadataOffset = Math.min(this.metadataOffset, maxMetadataOffset);
		if (metadata.selectedRange) {
			if (metadata.selectedRange.start < this.metadataOffset) {
				this.metadataOffset = metadata.selectedRange.start;
			} else if (metadata.selectedRange.end >= this.metadataOffset + bodyRows) {
				this.metadataOffset = Math.min(maxMetadataOffset, metadata.selectedRange.end - bodyRows + 1);
			}
		}

		const selectedGroup = selectedItem?.group;
		const title = this.snapshot.error
			? this.theme.fg("error", "Git indisponível")
			: this.theme.fg("accent", this.theme.bold(selectedGroup?.label ?? "Alterações"));
		const selectedFile = selectedItem?.kind === "file" ? selectedItem.file : undefined;
		const commitTotals = selectedGroup?.kind === "commit"
			? totalsForFiles(selectedGroup.files)
			: { additions: 0, deletions: 0 };
		const fileTotals = selectedFile ? totalsForFiles([selectedFile]) : { additions: 0, deletions: 0 };
		const branchTotals = totalsForFiles(this.snapshot.groups
			.filter((group) => group.kind === "commit")
			.flatMap((group) => group.files));
		const formatTotals = (totals: ChangeTotals): string =>
			`${this.theme.fg("success", `+${formatNumber(totals.additions)}`)} ${this.theme.fg("error", `-${formatNumber(totals.deletions)}`)}`;
		const stats = this.snapshot.error
			? ""
			: `Tot. Commit: ${formatTotals(commitTotals)} (${formatTotals(fileTotals)})    Tot. Branch: ${formatTotals(branchTotals)} `;
		const headerWidth = Math.max(1, innerWidth - 1);
		const statsWidth = visibleWidth(stats);
		const titleValue = truncateToWidth(title, Math.max(1, headerWidth - statsWidth - 1), "…");
		const headerGap = Math.max(1, headerWidth - visibleWidth(titleValue) - statsWidth);
		const header = ` ${titleValue}${" ".repeat(headerGap)}${stats}`;
		const contentRow = (content: string): string =>
			`│${padToWidth(content, innerWidth)}│`;
		const horizontalRow = (left: string, right: string): string =>
			`${left}${"─".repeat(innerWidth)}${right}`;
		// A haste vertical da divisória começa abaixo do cabeçalho; `┬` evita desenhá-la dentro do título.
		const separator = `├${"─".repeat(codeWidth)}┬${"─".repeat(metadataWidth)}┤`;
		const lines = [
			horizontalRow("╭", "╮"),
			contentRow(header),
			separator,
		];

		for (let row = 0; row < bodyRows; row++) {
			const codeLine = codeLines[codeStart + row] ?? "";
			const metadataLine = metadata.lines[this.metadataOffset + row] ?? "";
			lines.push(`│${padToWidth(codeLine, codeWidth)}│${padToWidth(metadataLine, metadataWidth)}│`);
		}

		const toggleLabel = this.showFullFile ? "diff" : "arquivo completo";
		const footerText = this.focus === "files"
			? ` ↑↓ K↑ J↓ arquivo  Enter arquivo  F ${toggleLabel}  Alt+D/Esc fechar `
			: ` ↑↓ K↑ J↓ rolar arquivo  ← arquivos  F ${toggleLabel}  Alt+D/Esc fechar `;
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
		const items = panelItems(this.snapshot, this.expandedCommits);
		if (items.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(index, items.length - 1));
		this.metadataOffset = 0;
		this.codeOffset = 0;
		this.tui.requestRender();
	}

	private selectedItem(): PanelItem | undefined {
		return panelItems(this.snapshot, this.expandedCommits)[this.selectedIndex];
	}

	private toggleCommit(groupId: string): void {
		if (this.expandedCommits.has(groupId)) {
			this.expandedCommits.delete(groupId);
		} else {
			this.expandedCommits.add(groupId);
		}
		this.metadataOffset = 0;
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
		if (!this.showFullFile || file.content === undefined) return this.renderDiffLines(file, width);

		const rawLines = file.content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
		const totalLines = rawLines.length;
		const removedLines = parseRemovedLines(file.diff);
		const removedByPosition = new Map<number, RemovedLine[]>();
		for (const removedLine of removedLines) {
			const linesAtPosition = removedByPosition.get(removedLine.position) ?? [];
			linesAtPosition.push(removedLine);
			removedByPosition.set(removedLine.position, linesAtPosition);
		}
		const maxLineNumber = Math.max(1, totalLines, ...removedLines.map((line) => line.lineNumber));
		const lineNumberWidth = String(maxLineNumber).length;
		const lines: string[] = [];
		const renderSourceLine = (lineNumber: number, color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", content: string): void => {
			const number = String(lineNumber).padStart(lineNumberWidth, " ");
			lines.push(truncateToWidth(
				`${this.theme.fg("dim", number)} │ ${this.theme.fg(color, content)}`,
				width,
				"",
			));
		};

		for (let lineNumber = 1; lineNumber <= totalLines; lineNumber++) {
			for (const removedLine of removedByPosition.get(lineNumber) ?? []) {
				renderSourceLine(removedLine.lineNumber, "toolDiffRemoved", removedLine.content);
			}
			const color = lineIsInRange(lineNumber, file.changedLineRanges)
				? "toolDiffAdded"
				: "toolDiffContext";
			renderSourceLine(lineNumber, color, rawLines[lineNumber - 1] ?? "");
		}
		for (const [position, linesAtPosition] of removedByPosition) {
			if (position <= totalLines) continue;
			for (const removedLine of linesAtPosition) {
				renderSourceLine(removedLine.lineNumber, "toolDiffRemoved", removedLine.content);
			}
		}
		return lines;
	}

	private renderDiffLines(file: ChangedFile, width: number): string[] {
		const rawLines = file.diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
		const codeLines: Array<{
			lineNumber: number;
			color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";
			content: string;
		}> = [];
		let oldLine = 0;
		let newLine = 0;
		let inHunk = false;

		for (const line of rawLines) {
			const hunk = parseHunkPosition(line);
			if (hunk) {
				oldLine = hunk.oldLine;
				newLine = hunk.newLine;
				inHunk = true;
				continue;
			}
			if (
				line.startsWith("diff --git ") ||
				line.startsWith("index ") ||
				line.startsWith("--- ") ||
				line.startsWith("+++ ") ||
				line.startsWith("old mode ") ||
				line.startsWith("new mode ") ||
				line.startsWith("new file mode ") ||
				line.startsWith("deleted file mode ") ||
				line.startsWith("similarity index ") ||
				line.startsWith("rename from ") ||
				line.startsWith("rename to ") ||
				line.startsWith("Binary files ") ||
				line === "\\ No newline at end of file"
			) continue;
			if (!inHunk) continue;

			if (line.startsWith("-") && !line.startsWith("--- ")) {
				codeLines.push({ lineNumber: Math.max(1, oldLine), color: "toolDiffRemoved", content: line.slice(1) });
				oldLine++;
			} else if (line.startsWith("+") && !line.startsWith("+++ ")) {
				codeLines.push({ lineNumber: Math.max(1, newLine), color: "toolDiffAdded", content: line.slice(1) });
				newLine++;
			} else if (line.startsWith(" ")) {
				codeLines.push({ lineNumber: Math.max(1, newLine), color: "toolDiffContext", content: line.slice(1) });
				oldLine++;
				newLine++;
			} else if (!line.startsWith("\\")) {
				codeLines.push({ lineNumber: Math.max(1, newLine), color: "toolDiffContext", content: line });
				oldLine++;
				newLine++;
			}
		}

		if (codeLines.length === 0) {
			return [truncateToWidth(this.theme.fg("dim", "Nenhum conteúdo textual disponível."), width, "")];
		}
		const lineNumberWidth = String(Math.max(...codeLines.map((line) => line.lineNumber))).length;
		return codeLines.map((line) => truncateToWidth(
			`${this.theme.fg("dim", String(line.lineNumber).padStart(lineNumberWidth, " "))} │ ${this.theme.fg(line.color, line.content)}`,
			width,
			"",
		));
	}

	private emptyCodeLines(width: number): string[] {
		if (panelItems(this.snapshot, this.expandedCommits).length === 0) {
			return [truncateToWidth(this.theme.fg("dim", "Nenhuma alteração desde o início da sessão."), width, "")];
		}
		return [truncateToWidth(this.theme.fg("dim", "Selecione um arquivo para ver o arquivo."), width, "")];
	}

	private renderMetadataLines(width: number): MetadataRender {
		const items = panelItems(this.snapshot, this.expandedCommits);
		if (items.length === 0) {
			return { lines: [this.theme.fg("dim", "Nenhum arquivo ou commit")] };
		}

		const lines: string[] = [];
		let selectedRange: LineRange | undefined;
		const selectedKey = itemKey(this.selectedItem());
		let previousGroupId: string | undefined;
		for (const item of items) {
			if (item.group.kind === "working-tree" && item.group.id !== previousGroupId) {
				lines.push(padToWidth(this.theme.fg("warning", ` ${item.group.label}`), width));
			}
			previousGroupId = item.group.id;
			const start = lines.length;
			const selected = itemKey(item) === selectedKey;
			if (item.kind === "commit") {
				const marker = selected ? (this.focus === "files" ? "▶ " : "• ") : "  ";
				const disclosure = this.expandedCommits.has(item.group.id) ? "▾ " : "▸ ";
				const label = `${marker}${disclosure}${item.group.label}`;
				const line = this.theme.fg("accent", label);
				lines.push(selected ? this.theme.bg("selectedBg", padToWidth(line, width)) : padToWidth(line, width));
			} else {
				const marker = selected ? (this.focus === "files" ? "▶ " : "• ") : "  ";
				const filename = `${marker}${truncatePathFromLeft(item.file.path, Math.max(1, width - visibleWidth(marker)))}`;
				const nameLine = selected
					? this.theme.bg("selectedBg", padToWidth(filename, width))
					: padToWidth(filename, width);
				const status = this.theme.fg(statusColor(item.file.status), item.file.status);
				const stats = `${status} ${this.theme.fg("success", `+${formatNumber(item.file.additions)}`)} ${this.theme.fg("error", `-${formatNumber(item.file.deletions)}`)}`;
				lines.push(nameLine, padToWidth(`  ${stats}`, width));
			}
			if (selected) selectedRange = { start, end: lines.length - 1 };
		}
		return { lines, selectedRange };
	}
}
