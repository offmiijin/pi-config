/**
 * pi-memory — Busca de memórias via ripgrep, fallback do índice SQLite
 * (sem dependência do PI).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT } from "./constants.ts";
import { parseFrontmatter } from "./memory.ts";

/**
 * Lê a confiança do frontmatter de um arquivo de memória.
 * Retorna undefined se o arquivo não puder ser lido ou não tiver confiança.
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
 * Resultados de uma busca de memórias.
 */
export interface SearchResult {
	/** Caminho absoluto do arquivo de memória */
	file: string;
	/** Linha(s) encontrada(s) com números de linha */
	lines: string[];
}

/**
 * Parâmetros do searchMemories.
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
 * Monta um padrão ripgrep a partir de uma lista de termos (semântica OR).
 * Cada termo é regex-escapado para casar literalmente (ex.: "C++" casa
 * "C++", não o quantificador). Retorna "" para entrada vazia.
 */
export function buildSearchPattern(terms: string[]): string {
	const escaped = terms
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.filter((t) => t.trim().length > 0);
	return escaped.join("|");
}

/**
 * Busca memórias via ripgrep (fallback quando o índice SQLite/FTS5 não está
 * disponível — falha de abertura/sync no startup).
 * Retorna caminhos de arquivo com linhas de contexto.
 */
export function searchMemories(options: SearchOptions): SearchResult[] {
	const { query, scope = "all", type, minConfidence, limit = 10 } = options;

	// Caminhos raiz por escopo — .supersedes/ é excluído naturalmente (não é
	// subcaminho de _global ou projects), sem glob de exclusão frágil.
	// scope=all = global + projeto ATUAL: memórias de outros projetos são
	// específicas e não podem vazar para a sessão atual.
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

	// Caminhos ausentes (projeto novo sem memórias) fariam o rg reclamar no
	// stderr e sair com status 2 — descartando resultados válidos do resto.
	searchPaths = searchPaths.filter((p) => existsSync(p));
	if (searchPaths.length === 0) return [];

	// --iglob: case-insensitive também nos globs de caminho (arquivos criados
	// à mão podem ter maiúsculas). Sessions é a única exclusão (fica em projects/).
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
		if (result.status === 1) return []; // sem matches (rg exit code 1)
		if (result.status !== 0) {
			throw new Error(`rg exited ${result.status}: ${result.stderr}`);
		}
		stdout = result.stdout ?? "";
	} catch (e: unknown) {
		// rg não instalado?
		const msg = (e as Error).message ?? String(e);
		if (msg.includes("ENOENT")) throw new Error("rg (ripgrep) not found — install with: apt install ripgrep");
		if (msg.includes("rg exited")) throw e;
		if ((e as { status?: number }).status === 1) return [];
		throw e;
	}

	if (!stdout.trim()) return [];

	const fileMap = new Map<string, string[]>();
	for (const line of stdout.trim().split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const filePath = line.slice(0, idx);
		const rest = line.slice(idx + 1);

		// O resto pode ter vários dois-pontos (linha:conteúdo)
		const lineEnd = rest.indexOf(":");
		if (lineEnd === -1) continue;
		const fileLine = rest.slice(0, lineEnd);
		const content = rest.slice(lineEnd + 1);

		if (!fileMap.has(filePath)) {
			fileMap.set(filePath, []);
		}
		fileMap.get(filePath)!.push(`L${fileLine}: ${content.trim()}`);
	}

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
