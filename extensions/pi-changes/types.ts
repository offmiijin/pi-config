export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "?";

export interface ChangedFile {
	path: string;
	status: ChangeStatus;
	additions: number;
	deletions: number;
	diff: string;
	content: string;
}

export interface ChangesSnapshot {
	files: ChangedFile[];
	totalAdditions: number;
	totalDeletions: number;
	error?: string;
}
