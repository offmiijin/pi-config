import type { ChangedFile, ChangeGroup, ChangeStatus, ChangesSnapshot } from "./types.ts";

export interface GitResult {
	stdout: string;
	stderr?: string;
	code: number;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;

export interface CollectChangesOptions {
	/** Commit inicial da sessão sandbox. Quando presente, separa os commits posteriores. */
	baseCommit?: string;
}

interface StatusEntry {
	path: string;
	status: ChangeStatus;
}

interface CommitEntry {
	hash: string;
	shortHash: string;
	subject: string;
}

const SANDBOX_METADATA_FILE = ".pi-sandbox-worktree.json";

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

/** Interpreta `git diff-tree --name-status -z`, preservando o caminho novo em renames. */
export function parseNameStatus(output: string): StatusEntry[] {
	const parts = output.split("\0");
	const entries: StatusEntry[] = [];
	let cursor = 0;

	while (cursor < parts.length) {
		const rawStatus = parts[cursor++] ?? "";
		if (!rawStatus) continue;
		const status = statusFromCode(rawStatus[0] ?? "M");
		if (status === "R" || status === "C") {
			cursor++; // caminho anterior
			const path = parts[cursor++] ?? "";
			if (path) entries.push({ path, status });
			continue;
		}
		const path = parts[cursor++] ?? "";
		if (path) entries.push({ path, status });
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

function statusFromCode(code: string): ChangeStatus {
	if (code === "D") return "D";
	if (code === "A") return "A";
	if (code === "R") return "R";
	if (code === "C") return "C";
	if (code === "?") return "?";
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

function parseCommits(output: string): CommitEntry[] {
	const fields = output.split("\0");
	const commits: CommitEntry[] = [];
	for (let cursor = 0; cursor + 2 < fields.length; cursor += 3) {
		const [hash, shortHash, subject] = fields.slice(cursor, cursor + 3);
		if (hash && shortHash) commits.push({ hash, shortHash, subject: subject ?? "" });
	}
	return commits;
}

function emptySnapshot(error?: string): ChangesSnapshot {
	return {
		groups: [],
		totalAdditions: 0,
		totalDeletions: 0,
		error,
	};
}

async function collectFile(
	entry: StatusEntry,
	runGit: GitRunner,
	diffArgs: string[],
	numstatArgs: string[],
): Promise<ChangedFile> {
	const [numstatResult, diffResult] = await Promise.all([
		runGit(numstatArgs),
		runGit(diffArgs),
	]);
	const stats = parseNumstat(numstatResult.stdout);
	return {
		path: entry.path,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		diff: diffResult.stdout || "(Nenhum diff textual disponível.)",
	};
}

async function collectCommitGroups(
	cwd: string,
	runGit: GitRunner,
	baseCommit: string,
): Promise<{ groups: ChangeGroup[]; error?: string }> {
	const baseResult = await runGit(["-C", cwd, "rev-parse", "--verify", `${baseCommit}^{commit}`]);
	if (baseResult.code !== 0) {
		return { groups: [], error: baseResult.stderr?.trim() || "Commit-base do sandbox não está disponível." };
	}

	const logResult = await runGit([
		"-C", cwd,
		"log",
		"--first-parent",
		"--reverse",
		"-z",
		"--format=%H%x00%h%x00%s",
		`${baseCommit}..HEAD`,
	]);
	if (logResult.code !== 0) {
		return { groups: [], error: logResult.stderr?.trim() || "Não foi possível ler os commits da sessão." };
	}

	const groups: ChangeGroup[] = [];
	for (const commit of parseCommits(logResult.stdout)) {
		const namesResult = await runGit([
			"-C", cwd,
			"diff-tree",
			"--root",
			"--first-parent",
			"-m",
			"--no-commit-id",
			"--name-status",
			"-r",
			"-z",
			"--find-renames",
			commit.hash,
		]);
		if (namesResult.code !== 0) {
			return { groups: [], error: namesResult.stderr?.trim() || `Não foi possível ler o commit ${commit.shortHash}.` };
		}

		const entries = parseNameStatus(namesResult.stdout)
			.filter((entry) => entry.path !== SANDBOX_METADATA_FILE);
		const files = await Promise.all(entries.map((entry) => collectFile(
			entry,
			runGit,
			["-C", cwd, "show", "--format=", "--first-parent", "-m", "--no-color", "--unified=3", commit.hash, "--", entry.path],
			["-C", cwd, "show", "--format=", "--first-parent", "-m", "--numstat", commit.hash, "--", entry.path],
		)));
		files.sort((a, b) => a.path.localeCompare(b.path));
		if (files.length > 0) {
			groups.push({
				id: `commit:${commit.hash}`,
				label: `${commit.shortHash} ${commit.subject}`.trim(),
				kind: "commit",
				files,
			});
		}
	}
	return { groups };
}

async function collectWorkingTreeGroup(
	cwd: string,
	runGit: GitRunner,
): Promise<{ group?: ChangeGroup; error?: string }> {
	const statusResult = await runGit([
		"-C", cwd,
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"-z",
	]);
	if (statusResult.code !== 0) {
		return { error: statusResult.stderr?.trim() || "Não foi possível ler o status do Git." };
	}

	const entries = parsePorcelainStatus(statusResult.stdout)
		.filter((entry) => entry.path !== SANDBOX_METADATA_FILE);
	if (entries.length === 0) return {};

	const headResult = await runGit(["-C", cwd, "rev-parse", "--verify", "HEAD"]);
	const hasHead = headResult.code === 0;
	const files = await Promise.all(entries.map((entry) => {
		const diffArgs = entry.status === "?" || !hasHead
			? ["-C", cwd, "diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", entry.path]
			: ["-C", cwd, "diff", "HEAD", "--no-color", "--unified=3", "--", entry.path];
		const separatorIndex = diffArgs.indexOf("--");
		const numstatArgs = [
			...diffArgs.slice(0, separatorIndex),
			"--numstat",
			...diffArgs.slice(separatorIndex),
		];
		return collectFile(entry, runGit, diffArgs, numstatArgs);
	}));
	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		group: {
			id: "working-tree",
			label: "Não commitadas",
			kind: "working-tree",
			files,
		},
	};
}

/**
 * Coleta commits da sessão (quando há commit-base) e alterações ainda não
 * commitadas. Cada commit vira um grupo independente no painel.
 */
export async function collectChanges(
	cwd: string,
	runGit: GitRunner,
	options: CollectChangesOptions = {},
): Promise<ChangesSnapshot> {
	const groups: ChangeGroup[] = [];
	if (options.baseCommit) {
		const committed = await collectCommitGroups(cwd, runGit, options.baseCommit);
		if (committed.error) return emptySnapshot(committed.error);
		groups.push(...committed.groups);
	}

	const workingTree = await collectWorkingTreeGroup(cwd, runGit);
	if (workingTree.error) return emptySnapshot(workingTree.error);
	if (workingTree.group) groups.push(workingTree.group);

	const files = groups.flatMap((group) => group.files);
	return {
		groups,
		totalAdditions: files.reduce((total, file) => total + file.additions, 0),
		totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
	};
}
