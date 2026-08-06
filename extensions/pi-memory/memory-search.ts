/**
 * pi-memory — Memory search via ripgrep (no PI dependency).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT } from "./constants.ts";
import { parseFrontmatter } from "./memory.ts";

// ── Memory search ─────────────────────────────────────────────────────────

/**
 * Reads the frontmatter confidence from a memory file.
 * Returns undefined if file can't be read or has no confidence.
 */
export function readFileConfidence(filePath: string): number | undefined {
	try {
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const { meta } = parseFrontmatter(content);
		const conf = meta.confidence;
		return typeof conf === "number" ? conf : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Results from a memory search.
 */
export interface SearchResult {
	/** Absolute path to the memory file */
	file: string;
	/** Matched line(s) with line numbers */
	lines: string[];
}

/**
 * Parameters for searchMemories.
 */
export interface SearchOptions {
	query: string;
	scope?: "global" | "project" | "all";
	type?: string;
	minConfidence?: number;
	limit?: number;
	/** Project id — obrigatório quando scope === "project". */
	projectId?: string;
}

/**
 * Builds a ripgrep pattern from a list of terms (OR semantics).
 * Each term is regex-escaped so plain keywords match literally
 * (e.g. "C++" matches "C++", not the regex quantifier).
 * Returns "" for empty input.
 */
export function buildSearchPattern(terms: string[]): string {
	const escaped = terms
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.filter((t) => t.trim().length > 0);
	return escaped.join("|");
}

/**
 * Searches memories via ripgrep.
 * Returns matching file paths with context lines.
 */
export function searchMemories(options: SearchOptions): SearchResult[] {
	const { query, scope = "all", type, minConfidence, limit = 10 } = options;

	// Paths raiz por escopo — .supersedes/ fica excluído naturalmente (não é
	// subpath de _global nem projects), sem glob de exclusão frágil.
	// scope=all = global + projeto ATUAL: memórias de outros projetos são
	// específicas de cada projeto e não devem vazar para a sessão atual.
	let searchPaths: string[];
	if (scope === "global") {
		searchPaths = [join(MEMORIES_ROOT, "_global")];
	} else {
		if (!options.projectId) {
			throw new Error("searchMemories: projectId é obrigatório para scope=project/all");
		}
		const projectPath = join(MEMORIES_ROOT, "projects", options.projectId);
		searchPaths =
			scope === "all"
				? [join(MEMORIES_ROOT, "_global"), projectPath]
				: [projectPath];
	}

	// Paths inexistentes (projeto novo sem memórias) fariam o rg reclamar no
	// stderr e sair com status 2 — descartaria resultados válidos dos demais.
	searchPaths = searchPaths.filter((p) => existsSync(p));
	if (searchPaths.length === 0) return [];

	// --iglob: case-insensitive também nos globs de path (arquivos criados à
	// mão podem ter maiúsculas). Sessions é a única exclusão (fica sob projects/).
	const rgArgs: string[] = ["--no-heading", "--line-number", "-i"];
	rgArgs.push("--iglob", type ? `**/${type}/*.md` : "**/*.md");
	rgArgs.push("--glob", "!**/sessions/**");

	rgArgs.push("--", query, ...searchPaths);

	let stdout: string;
	try {
		const result = spawnSync("rg", rgArgs, {
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10000,
		});
		if (result.error) throw result.error;
		if (result.status === null) throw new Error("rg process failed to spawn");
		if (result.status === 1) return []; // no matches (rg exit code 1)
		if (result.status !== 0) {
			throw new Error(`rg exited ${result.status}: ${result.stderr}`);
		}
		stdout = result.stdout ?? "";
	} catch (e: unknown) {
		// rg not installed?
		const msg = (e as Error).message ?? String(e);
		if (msg.includes("ENOENT")) throw new Error("rg (ripgrep) not found — install with: apt install ripgrep");
		if (msg.includes("rg exited")) throw e;
		if ((e as { status?: number }).status === 1) return [];
		throw e;
	}

	if (!stdout.trim()) return [];

	// Parse output: file:line:content
	// Group by file
	const fileMap = new Map<string, string[]>();
	for (const line of stdout.trim().split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const filePath = line.slice(0, idx);
		const rest = line.slice(idx + 1);

		// The rest may have multiple colons (line:content)
		const lineEnd = rest.indexOf(":");
		if (lineEnd === -1) continue;
		const fileLine = rest.slice(0, lineEnd);
		const content = rest.slice(lineEnd + 1);

		if (!fileMap.has(filePath)) {
			fileMap.set(filePath, []);
		}
		fileMap.get(filePath)!.push(`L${fileLine}: ${content.trim()}`);
	}

	// Build results, filter by confidence, sort, limit
	const results: SearchResult[] = [];
	for (const [file, lines] of fileMap) {
		if (minConfidence !== undefined) {
			const conf = readFileConfidence(file);
			if (conf === undefined || conf < minConfidence) continue;
		}
		results.push({ file, lines });
	}

	return results.slice(0, limit);
}
