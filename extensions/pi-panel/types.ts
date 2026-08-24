export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "?";

export interface ChangedFile {
	path: string;
	status: ChangeStatus;
	additions: number;
	deletions: number;
	diff: string;
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
