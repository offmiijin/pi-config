/**
 * pi-memory — CRUD de arquivos de memória + índice + save (sem dependência do PI).
 *
 * Caminhos de arquivo, frontmatter, entradas, supersede, índice/resumos e o
 * saveMemory compartilhado por memory_save e memory_extract.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT, MEMORY_TYPES } from "./constants.ts";
import { ensureFileDir, formatDateTime } from "./session.ts";

/**
 * Sanitiza uma string para ser segura como nome de arquivo.
 * Minúsculas, não alfanuméricos viram hífens, hífens repetidos colapsam.
 */
export function sanitizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Retorna o caminho do arquivo de uma memória dado escopo, tipo e contexto.
 */
export function getMemoryFilePath(
	projectId: string,
	type: string,
	context: string,
	scope: "global" | "project",
): string {
	const filename = `${sanitizeFilename(context)}.md`;
	if (scope === "global") {
		return join(MEMORIES_ROOT, "_global", type, filename);
	}
	return join(MEMORIES_ROOT, "projects", projectId, type, filename);
}

/**
 * Retorna o caminho em .supersedes/ para um caminho de arquivo de memória.
 */
export function getSupersedesPath(originalPath: string): string {
	const relative = originalPath.startsWith(MEMORIES_ROOT + "/")
		? originalPath.slice(MEMORIES_ROOT.length + 1)
		: originalPath;
	return join(MEMORIES_ROOT, ".supersedes", relative);
}

/**
 * Move um arquivo de memória para .supersedes/, preservando a estrutura e
 * adicionando metadados de superseded. O arquivo original é removido.
 * Retorna o novo caminho.
 */
export function moveToSupersedes(
	filePath: string,
	extraMeta: Record<string, unknown> = {},
): string {
	const content = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(content);

	meta.superseded_at = new Date().toISOString().slice(0, 10);
	meta.confidence = 0;
	for (const [k, v] of Object.entries(extraMeta)) {
		meta[k] = v;
	}

	const supPath = getSupersedesPath(filePath);
	ensureFileDir(supPath);
	writeFileSync(supPath, formatFrontmatter(meta) + body);
	rmSync(filePath, { force: true });
	return supPath;
}

/**
 * Encontra o arquivo de memória de um contexto em todos os tipos e escopos.
 * Retorna undefined se não encontrar.
 */
export function findMemoryFile(
	projectId: string,
	context: string,
): string | undefined {
	for (const scope of ["global", "project"] as const) {
		for (const type of MEMORY_TYPES) {
			const fp = getMemoryFilePath(projectId, type, context, scope);
			if (existsSync(fp)) return fp;
		}
	}
	return undefined;
}

/**
 * Lista as chaves de contexto existentes para um projeto (escopos global +
 * projeto). Usado pelo memory_extract para o LLM reutilizar chaves e superseder.
 */
export function listMemoryContexts(projectId: string): {
	global: string[];
	project: string[];
} {
	const globalKeys: string[] = [];
	const projectKeys: string[] = [];

	for (const type of MEMORY_TYPES) {
		for (const dir of [
			join(MEMORIES_ROOT, "_global", type),
			join(MEMORIES_ROOT, "projects", projectId, type),
		]) {
			if (!existsSync(dir)) continue;
			const isGlobal = dir.includes("_global");
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				const key = f.slice(0, -3);
				if (isGlobal) globalKeys.push(key);
				else projectKeys.push(key);
			}
		}
	}

	return { global: globalKeys.sort(), project: projectKeys.sort() };
}

/**
 * Uma entrada de memória no índice de sessão / contexto de dedup da extração.
 */
export interface MemoryIndexEntry {
	scope: "global" | "project";
	type: MemoryType;
	context: string;
	/** Título da entrada mais recente do corpo. */
	title: string;
	confidence: number;
	updated: string;
	/** Summary persistido (frontmatter), se houver. */
	summary?: string;
	/** Trecho cru do fim do corpo (fallback quando não há summary). */
	excerpt: string;
}

/** Extrai o título da ÚLTIMA entrada do corpo de uma memória. */
export function extractLastEntryTitle(body: string): string | undefined {
	const matches = [...body.matchAll(/^## \[[^\]]+\]\s+(.+)$/gm)];
	if (matches.length === 0) return undefined;
	return matches[matches.length - 1][1].trim();
}

/** Trecho cru do fim do corpo (append adiciona entradas novas por último). */
function extractExcerpt(body: string, maxChars = 150): string {
	const clean = body
		.replace(/^## \[[^\]]+\][^\n]*\n/g, "")
		.replace(/^confidence:.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (clean.length <= maxChars) return clean;
	return clean.slice(-maxChars).trimStart() + "…";
}

/**
 * Lista todas as memórias (global + projeto) com metadados, ordenadas por
 * updated desc. Lê frontmatter (confidence, updated, summary) + título da
 * última entrada.
 */
export function listMemoryIndex(projectId: string): MemoryIndexEntry[] {
	const entries: MemoryIndexEntry[] = [];
	for (const scope of ["global", "project"] as const) {
		for (const type of MEMORY_TYPES) {
			const dir =
				scope === "global"
					? join(MEMORIES_ROOT, "_global", type)
					: join(MEMORIES_ROOT, "projects", projectId, type);
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				const context = f.slice(0, -3);
				const filePath = join(dir, f);
				try {
					const content = readFileSync(filePath, "utf-8");
					const { meta, body } = parseFrontmatter(content);
					entries.push({
						scope,
						type,
						context,
						title: extractLastEntryTitle(body) ?? context,
						confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
						updated: typeof meta.updated === "string" ? meta.updated : "",
						...(typeof meta.summary === "string" ? { summary: meta.summary } : {}),
						excerpt: extractExcerpt(body),
					});
				} catch {
					// Arquivo corrompido — ignora, não quebra o índice.
				}
			}
		}
	}
	return entries.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

/** Formata contagens por escopo na ordem fixa de MEMORY_TYPES, sem omitir 0. */
function formatCountsByScope(entries: MemoryIndexEntry[]): string[] {
	const lines: string[] = [];
	for (const scope of ["global", "project"] as const) {
		const counts = MEMORY_TYPES.map((t) => {
			const n = entries.filter((e) => e.scope === scope && e.type === t).length;
			return `${t} (${n} memories)`;
		});
		lines.push(`  ${scope === "global" ? "_global" : "project"}: ${counts.join(", ")}`);
	}
	return lines;
}

/**
 * Formata o índice de memórias injetado uma vez por sessão
 * (before_agent_start). Total sempre; 15 mais recentes; resto resumido por
 * escopo+tipo; contagens completas.
 */
export function formatMemoryIndexText(entries: MemoryIndexEntry[]): string {
	const total = entries.length;
	const lines: string[] = [];
	lines.push(`[pi-memory] Memory index (total: ${total} — call memory_search for details):`);
	lines.push("");
	lines.push("Most recent 15:");

	const recent = entries.slice(0, 15);
	if (recent.length === 0) {
		lines.push("  (none yet — call memory_save when you learn something durable)");
	} else {
		for (const e of recent) {
			lines.push(
				`  ${e.scope}/${e.type}/${e.context} (${e.confidence}, ${e.updated}): "${e.title}"`,
			);
		}
	}

	const rest = entries.slice(15);
	if (rest.length > 0) {
		lines.push("");
		lines.push(`${rest.length} not shown — by scope:`);
		lines.push(...formatCountsByScope(rest));
	}

	lines.push("");
	lines.push("Counts by scope (all):");
	lines.push(...formatCountsByScope(entries));
	return lines.join("\n");
}

/**
 * Monta o bloco 'Existing memories' do prompt de extração.
 * Usa o summary persistido quando disponível; senão cai para título + trecho.
 */
export function summarizeExistingMemories(projectId: string): string {
	const entries = listMemoryIndex(projectId);
	const lines: string[] = [
		"Existing memories (reuse context keys; 'mode: consolidate' if new info updates/contradicts the SAME key; 'supersedes' if it replaces a DIFFERENT key):",
		"",
	];
	if (entries.length === 0) {
		lines.push("  (none)");
		return lines.join("\n");
	}
	for (const e of entries) {
		const text = e.summary ? e.summary : `${e.title} — ${e.excerpt}`;
		lines.push(
			`  ${e.scope}/${e.type}/${e.context} (${e.confidence}, updated ${e.updated}): "${text}"`,
		);
	}
	return lines.join("\n");
}

/**
 * Aplica um delta de decay a um valor de confiança, limitado a 0.
 * O delta é tratado como redução independentemente do sinal.
 */
export function applyDecay(currentConfidence: number, delta: number): number {
	return Math.max(0, Math.round((currentConfidence - Math.abs(delta)) * 100) / 100);
}

/**
 * Interpreta YAML frontmatter de um arquivo markdown.
 * Retorna metadados e corpo separadamente.
 */
export function parseFrontmatter(content: string): {
	meta: Record<string, unknown>;
	body: string;
} {
	if (!content.startsWith("---\n")) return { meta: {}, body: content };

	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return { meta: {}, body: content };

	const yaml = content.slice(4, endIdx);
	const body = content.slice(endIdx + 5);

	const meta: Record<string, unknown> = {};
	for (const line of yaml.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^(\w+):\s*(.*)$/);
		if (!match) continue;

		let value: unknown = match[2].trim();

		// Array: ["a", "b"]
		if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
		} else if (
			typeof value === "string" &&
			value.startsWith('"') &&
			value.endsWith('"')
		) {
			// String entre aspas — unescape (\n, \", \\)
			value = value
				.slice(1, -1)
				.replace(/\\n/g, "\n")
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, "\\");
		} else if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (typeof value === "string" && !isNaN(Number(value))) value = Number(value);

		meta[match[1]] = value;
	}

	return { meta, body };
}

/** Escapa uma string como scalar YAML entre aspas duplas. */
function yamlQuoteString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Formata metadados como string de frontmatter YAML.
 */
export function formatFrontmatter(meta: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(meta)) {
		if (Array.isArray(value)) {
			lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
		} else if (typeof value === "number") {
			lines.push(`${key}: ${value}`);
		} else if (typeof value === "boolean") {
			lines.push(`${key}: ${value}`);
		} else {
			// Strings sempre entre aspas — valores com ":" ou "\n" não quebram o YAML
			lines.push(`${key}: ${yamlQuoteString(String(value))}`);
		}
	}
	lines.push("---");
	return lines.join("\n") + "\n";
}

/**
 * Formata uma entrada de memória como markdown.
 */
export function formatMemoryEntry(
	date: string,
	title: string,
	content: string,
	confidence?: number,
): string {
	const lines: string[] = [];
	if (confidence !== undefined) {
		lines.push(`## [${date}] ${title}`);
		lines.push(`confidence: ${confidence}`);
	} else {
		lines.push(`## [${date}] ${title}`);
	}
	lines.push("");
	lines.push(content.trim());
	lines.push("");
	return lines.join("\n");
}

/**
 * Extrai valores de confiança de todas as entradas do corpo do arquivo.
 */
export function extractEntryConfidences(body: string): number[] {
	const confidences: number[] = [];
	const regex = /^confidence:\s*([\d.]+)$/gm;
	let match;
	while ((match = regex.exec(body)) !== null) {
		const val = parseFloat(match[1]);
		if (!isNaN(val)) confidences.push(val);
	}
	return confidences;
}

/**
 * Recalcula a confiança geral como média das confianças das entradas,
 * caindo para o default se nenhuma tiver confiança explícita.
 */
export function recalcOverallConfidence(
	existingConfidences: number[],
	newConfidence: number,
): number {
	const all = [...existingConfidences, newConfidence];
	if (all.length === 0) return 0.5;
	const sum = all.reduce((a, b) => a + b, 0);
	return Math.round((sum / all.length) * 100) / 100;
}

/**
 * Parâmetros de entrada do saveMemory.
 */
export interface SaveMemoryParams {
	type: string;
	context: string;
	title: string;
	content: string;
	scope: "global" | "project";
	tags?: string[];
	confidence?: number;
	supersedes?: string;
	/**
	 * Resumo conciso (1-2 frases, PT-BR) do estado ATUAL da memória.
	 * Persistido no frontmatter e sobrescrito em todo append/consolidate
	 * quando fornecido. Usado pelo memory_extract para dedup.
	 */
	summary?: string;
	/**
	 * append (padrão): adiciona entrada datada ao arquivo (retrocompatível).
	 * consolidate: reescreve a memória — arquiva a versão atual em .supersedes/
	 * e cria arquivo novo (use quando o conteúdo novo atualiza ou contradiz a
	 * memória existente com a MESMA chave de contexto; para substituir memória
	 * de OUTRA chave, use supersedes).
	 */
	mode?: "append" | "consolidate";
}

/**
 * Salva ou atualiza um arquivo de memória. Compartilhado por memory_save e
 * memory_extract.
 *
 * - Contexto novo → cria arquivo com frontmatter + primeira entrada
 * - Contexto existente → anexa entrada e atualiza frontmatter (entries, confidence, tags)
 * - supersedes → move a memória antiga para .supersedes/ primeiro
 * - mode "consolidate" → arquiva a versão atual do MESMO contexto em
 *   .supersedes/ e cria arquivo novo (merge-in-place, sem crescimento por append)
 */
export function saveMemory(
	projectId: string,
	params: SaveMemoryParams,
): {
	action: "created" | "appended" | "consolidated" | "error";
	file: string;
	entries?: number;
	error?: string;
	/** Paths absolutos arquivados em .supersedes/ por supersedes|consolidate. */
	archived: string[];
} {
	const { type, context, title, content, scope, tags = [], confidence = 0.5, supersedes, mode = "append", summary } = params;
	const now = formatDateTime();
	const today = now.slice(0, 10);
	// Paths movidos para .supersedes/ nesta chamada — o índice SQLite precisa
	// removê-los da FTS (memória antiga não pode continuar buscável).
	const archived: string[] = [];

	// Guarda defensiva: tipo inválido criaria diretório no lugar errado
	// (ex.: "gotcha" no singular em vez de "gotchas") e geraria memórias órfãs.
	if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
		return {
			action: "error",
			file: "",
			error: `Invalid memory type "${type}" (expected one of: ${MEMORY_TYPES.join(", ")})`,
			archived,
		};
	}

	// Busca em TODOS os tipos/escopos (findMemoryFile) — a contradição costuma
	// cruzar tipo (ex.: lesson supersede pattern). Olhar só o tipo+escopo do
	// novo save resultaria em no-op silencioso.
	if (supersedes) {
		const oldPath = findMemoryFile(projectId, supersedes);
		if (oldPath) {
			moveToSupersedes(oldPath, { superseded_by: context });
			archived.push(oldPath);
		}
	}

	// Consolidate: arquiva a versão atual do MESMO contexto antes de criar a
	// nova — merge-in-place via .supersedes (histórico preservado, arquivo
	// sempre limpo, confiança sem distorção de média acumulada).
	let consolidated = false;
	if (mode === "consolidate") {
		const ownPath = getMemoryFilePath(projectId, type, context, scope);
		if (existsSync(ownPath)) {
			moveToSupersedes(ownPath, {
				superseded_by: context,
				superseded_reason: "consolidated",
			});
			archived.push(ownPath);
			consolidated = true;
		}
	}

	const filePath = getMemoryFilePath(projectId, type, context, scope);
	ensureFileDir(filePath);

	const entry = formatMemoryEntry(now, title, content, confidence);

	if (!existsSync(filePath)) {
		const meta: Record<string, unknown> = {
			context,
			type,
			created: today,
			updated: today,
			confidence,
			entries: 1,
		};
		if (tags.length > 0) meta.tags = tags;
		if (summary) meta.summary = summary;

		writeFileSync(filePath, formatFrontmatter(meta) + entry + "\n");
		return {
			action: consolidated ? "consolidated" : "created",
			file: filePath,
			archived,
		};
	}

	const existing = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(existing);
	// Média ponderada real: currentConf é a média das entradas atuais (e já
	// reflete decays). (currentConf * N + new) / (N+1) converge para a média
	// exata — média sucessiva (a+b)/2 penderia para a entrada mais recente.
	// Recalcular do corpo faria o decay sumir no append.
	const currentConf = typeof meta.confidence === "number" ? meta.confidence : 0.5;
	const currentEntries = (meta.entries as number) || extractEntryConfidences(body).length || 1;
	const newOverall = Math.round(((currentConf * currentEntries + confidence) / (currentEntries + 1)) * 100) / 100;

	meta.updated = today;
	meta.confidence = newOverall;
	meta.entries = currentEntries + 1;

	if (tags.length > 0) {
		const existingTags = (meta.tags as string[]) || [];
		meta.tags = [...new Set([...existingTags, ...tags])];
	}

	// Summary sempre reflete o estado ATUAL — sobrescreve o anterior.
	if (summary) meta.summary = summary;

	writeFileSync(filePath, formatFrontmatter(meta) + body + entry + "\n");
	return { action: "appended", file: filePath, entries: meta.entries as number, archived };
}
