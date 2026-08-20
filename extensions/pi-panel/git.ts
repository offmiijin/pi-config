import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChangedFile, ChangeStatus, ChangesSnapshot } from "./types.ts";

export interface GitResult {
	stdout: string;
	stderr?: string;
	code: number;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;

interface StatusEntry {
	path: string;
	status: ChangeStatus;
}

/** Interpreta a saída NUL-delimitada de `git status --porcelain=v1`. */
export function parsePorcelainStatus(output: string): StatusEntry[] {
	const entries: StatusEntry[] = [];
	let cursor = 0;

	while (cursor < output.length) {
		const end = output.indexOf("\0", cursor);
		const record = output.slice(cursor, end === -1 ? output.length : end);
		cursor = end === -1 ? output.length : end + 1;
		if (record.length < 4) continue;

		const xy = record.slice(0, 2);
		const path = record.slice(3);
		if (!path) continue;

		entries.push({ path, status: statusFromPorcelain(xy) });

		// Em renames/cópias, o caminho anterior vem no próximo registro NUL.
		if (xy.includes("R") || xy.includes("C")) {
			const oldPathEnd = output.indexOf("\0", cursor);
			cursor = oldPathEnd === -1 ? output.length : oldPathEnd + 1;
		}
	}

	return entries;
}

export function statusFromPorcelain(xy: string): ChangeStatus {
	if (xy === "??") return "?";
	if (xy.includes("D")) return "D";
	if (xy.includes("A")) return "A";
	if (xy.includes("R")) return "R";
	if (xy.includes("C")) return "C";
	return "M";
}

/** Extrai adições/remoções da primeira linha de `git diff --numstat`. */
export function parseNumstat(output: string): { additions: number; deletions: number } {
	const firstLine = output.split("\0", 1)[0]?.split("\n", 1)[0] ?? "";
	const match = firstLine.match(/^(\d+|-)\s+(\d+|-)(?:\t|\s{2,})/);
	if (!match) return { additions: 0, deletions: 0 };

	return {
		additions: match[1] === "-" ? 0 : Number(match[1]),
		deletions: match[2] === "-" ? 0 : Number(match[2]),
	};
}

async function readWorkingTreeFile(cwd: string, filePath: string, status: ChangeStatus): Promise<string> {
	if (status === "D") return "(Arquivo removido; conteúdo não disponível.)";

	try {
		const content = await readFile(resolve(cwd, filePath), "utf8");
		if (content.includes("\0")) return "(Arquivo binário; conteúdo não exibido.)";
		return content;
	} catch {
		return "(Conteúdo do arquivo não está disponível.)";
	}
}

function emptySnapshot(error?: string): ChangesSnapshot {
	return {
		files: [],
		totalAdditions: 0,
		totalDeletions: 0,
		error,
	};
}

/**
 * Coleta o estado do working tree e os diffs relativos a HEAD.
 * Arquivos não rastreados são comparados contra `/dev/null`.
 */
export async function collectChanges(cwd: string, runGit: GitRunner): Promise<ChangesSnapshot> {
	const statusResult = await runGit([
		"-C", cwd,
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"-z",
	]);
	if (statusResult.code !== 0) {
		return emptySnapshot(statusResult.stderr?.trim() || "Não foi possível ler o status do Git.");
	}

	const statusEntries = parsePorcelainStatus(statusResult.stdout);
	if (statusEntries.length === 0) return emptySnapshot();

	const headResult = await runGit(["-C", cwd, "rev-parse", "--verify", "HEAD"]);
	const hasHead = headResult.code === 0;
	const files: ChangedFile[] = [];

	for (const entry of statusEntries) {
		const diffArgs = entry.status === "?" || !hasHead
			? ["-C", cwd, "diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", entry.path]
			: ["-C", cwd, "diff", "HEAD", "--no-color", "--unified=3", "--", entry.path];

		const separatorIndex = diffArgs.indexOf("--");
		const numstatArgs = [
			...diffArgs.slice(0, separatorIndex),
			"--numstat",
			...diffArgs.slice(separatorIndex),
		];
		const [numstatResult, diffResult, content] = await Promise.all([
			runGit(numstatArgs),
			runGit(diffArgs),
			readWorkingTreeFile(cwd, entry.path, entry.status),
		]);
		const stats = parseNumstat(numstatResult.stdout);

		files.push({
			path: entry.path,
			status: entry.status,
			additions: stats.additions,
			deletions: stats.deletions,
			diff: diffResult.stdout || "(Nenhum diff textual disponível.)",
			content,
		});
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		files,
		totalAdditions: files.reduce((total, file) => total + file.additions, 0),
		totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
	};
}
