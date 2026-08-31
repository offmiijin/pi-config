export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "?";

export interface LineRange {
	start: number;
	end: number;
}

export interface ChangedFile {
	path: string;
	status: ChangeStatus;
	additions: number;
	deletions: number;
	diff: string;
	/** Conteúdo do arquivo após a alteração, quando é um arquivo textual disponível. */
	content?: string;
	/** Linhas novas afetadas pelos hunks do diff. */
	changedLineRanges: LineRange[];
}

export interface ChangeGroup {
	id: string;
	label: string;
	kind: "commit" | "working-tree";
	files: ChangedFile[];
}

export interface ChangesSnapshot {
	groups: ChangeGroup[];
	totalAdditions: number;
	totalDeletions: number;
	error?: string;
}
