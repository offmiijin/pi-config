/**
 * pi-memory — CRUD de arquivos de memória + índice + save (sem dependência do PI).
 *
 * Caminhos de arquivo, frontmatter, entradas, supersede, índice/resumos e o
 * saveMemory compartilhado por memory_save e memory_extract.
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { MEMORIES_ROOT, MEMORY_TYPES, type MemoryType } from "./constants.ts";
import { ensureFileDir } from "./session.ts";

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
 * Memória substituída por OUTRA chave (semântica de obsolescência).
 */
export function getSupersedesPath(originalPath: string): string {
	const relative = originalPath.startsWith(MEMORIES_ROOT + "/")
		? originalPath.slice(MEMORIES_ROOT.length + 1)
		: originalPath;
	return join(MEMORIES_ROOT, ".supersedes", relative);
}

/**
 * Retorna o caminho em .history/ para uma revisão de um arquivo de memória:
 *   _global/gotchas/foo.md → .history/_global/gotchas/foo/v{N}.md
 * Versão anterior do MESMO contexto (semântica de revisão).
 */
export function getHistoryPath(filePath: string, revision: number): string {
	const relative = filePath.startsWith(MEMORIES_ROOT + "/")
		? filePath.slice(MEMORIES_ROOT.length + 1)
		: filePath;
	const dir = dirname(relative);
	const base = basename(relative, ".md");
	return join(MEMORIES_ROOT, ".history", dir, base, `v${revision}.md`);
}

/**
 * Escrita atômica de arquivo: grava num temporário no MESMO diretório e
 * renomeia sobre o destino (rename é atômico no mesmo filesystem). Falha de
 * escrita não deixa o destino sem conteúdo — o snapshot anterior permanece
 * até o rename completar.
 */
function writeFileAtomic(filePath: string, content: string): void {
	const tmpPath = `${filePath}.tmp`;
	try {
		writeFileSync(tmpPath, content);
		renameSync(tmpPath, filePath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		throw err;
	}
}

/**
 * Escreve uma cópia de arquivo de memória (.history/.supersedes/) a partir
 * do conteúdo lido ANTES da substituição — variante de archiveFile que NÃO
 * remove o original (o snapshot ativo é substituído atomicamente em
 * separado). Usada pelo saveMemory/migração: se a escrita nova falhar, nada
 * foi removido e a operação é retentável.
 */
function archiveContent(
	rawContent: string,
	targetPath: string,
	extraMeta: Record<string, unknown> = {},
): void {
	const { meta, body } = parseFrontmatter(rawContent);
	meta.superseded_at = new Date().toISOString().slice(0, 10);
	meta.confidence = 0;
	for (const [k, v] of Object.entries(extraMeta)) {
		meta[k] = v;
	}
	ensureFileDir(targetPath);
	writeFileAtomic(targetPath, formatFrontmatter(meta) + body);
}

/**
 * Arquiva um arquivo de memória (frontmatter + corpo) num caminho de
 * destino, com metadados de superseded e confidence zerada. O original é
 * removido. Usado por .supersedes/ (moveToSupersedes) e .history/ (revisão).
 */
export function archiveFile(
	filePath: string,
	targetPath: string,
	extraMeta: Record<string, unknown> = {},
): string {
	const content = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(content);

	meta.superseded_at = new Date().toISOString().slice(0, 10);
	meta.confidence = 0;
	for (const [k, v] of Object.entries(extraMeta)) {
		meta[k] = v;
	}

	ensureFileDir(targetPath);
	writeFileSync(targetPath, formatFrontmatter(meta) + body);
	rmSync(filePath, { force: true });
	return targetPath;
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
	return archiveFile(filePath, getSupersedesPath(filePath), extraMeta);
}

/** Título v2 (snapshot): linha `# Título` do corpo. */
export function extractTitle(body: string): string | undefined {
	const m = body.match(/^#\s+(.+)$/m);
	return m ? m[1].trim() : undefined;
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
		.replace(/^#\s+.*$/m, "") // título v2 (snapshot)
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
						title: extractTitle(body) ?? extractLastEntryTitle(body) ?? context,
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
 * Parâmetros de entrada do saveMemory (Fase 5 — snapshot consolidado).
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
	 * Persistido no frontmatter e sobrescrito em toda escrita quando
	 * fornecido. Usado pelo memory_extract para dedup.
	 */
	summary?: string;
	/** Ids de evidência do pipeline que embasam esta versão (frontmatter). */
	evidence?: string[];
}

/**
 * Salva ou atualiza um arquivo de memória. Compartilhado por memory_save e
 * pelo commit do pipeline (Fase 4/5).
 *
 * Fase 5 — snapshot consolidado:
 * - Contexto novo → cria arquivo com frontmatter v2 (revision: 1, created,
 *   updated, confidence, scope, tags, summary, evidence).
 * - Contexto existente → a versão atual vai para .history/{context}/v{N}.md
 *   e a nova substitui o ativo (revision N+1).
 * - supersedes → move a memória da OUTRA chave para .supersedes/ primeiro.
 *
 * Retorna revision atual e os paths arquivados (o índice SQLite precisa
 * removê-los da FTS — memória antiga não pode continuar buscável).
 */
export function saveMemory(
	projectId: string,
	params: SaveMemoryParams,
): {
	action: "created" | "consolidated" | "error";
	file: string;
	revision: number;
	error?: string;
	/** Paths absolutos arquivados nesta chamada (.supersedes/ ou .history/). */
	archived: string[];
} {
	const {
		type,
		context,
		title,
		content,
		scope,
		tags = [],
		confidence = 0.5,
		supersedes,
		summary,
		evidence = [],
	} = params;
	const today = new Date().toISOString().slice(0, 10);
	const archived: string[] = [];

	// Guarda defensiva: tipo inválido criaria diretório no lugar errado
	// (ex.: "gotcha" no singular em vez de "gotchas") e geraria memórias órfãs.
	if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
		return {
			action: "error",
			file: "",
			revision: 0,
			error: `Invalid memory type "${type}" (expected one of: ${MEMORY_TYPES.join(", ")})`,
			archived,
		};
	}

	// Busca em TODOS os tipos/escopos (findMemoryFile) — a contradição costuma
	// cruzar tipo (ex.: lesson supersede pattern). Olhar só o tipo+escopo do
	// novo save resultaria em no-op silencioso.
	const filePath = getMemoryFilePath(projectId, type, context, scope);
	ensureFileDir(filePath);

	// Arquivos a arquivar — as CÓPIAS (.history/.supersedes/) são escritas
	// ANTES da substituição do snapshot ativo (Bloqueador 4): se a escrita
	// nova falhar, nada foi removido nem sobrescrito. Originais de OUTRAS
	// chaves (supersedes/context_moved) só são removidos DEPOIS do snapshot
	// novo estar em disco.
	type PendingArchive = {
		raw: string;
		targetPath: string;
		extraMeta: Record<string, unknown>;
		/** Original ainda existe e precisa ser removido (arquivo de outra chave). */
		removeOriginalPath: string | null;
	};
	const pendingArchives: PendingArchive[] = [];

	if (supersedes) {
		const oldPath = findMemoryFile(projectId, supersedes);
		if (oldPath) {
			pendingArchives.push({
				raw: readFileSync(oldPath, "utf-8"),
				targetPath: getSupersedesPath(oldPath),
				extraMeta: { superseded_by: context },
				removeOriginalPath: oldPath,
			});
			archived.push(oldPath);
		}
	}

	// Garantia de unicidade: se o contexto já existe em OUTRO path (type ou
	// scope divergentes — ex.: update migrou lessons → decisions), a versão
	// antiga é arquivada para .history/ antes de criar a nova. Sem isso,
	// duas memórias ativas com a MESMA context key quebrariam o contrato
	// "mesma key = mesmo arquivo" (findMemoryFile retornaria uma delas por
	// ordem de busca, com a outra invisível para o pipeline de dedup).
	const existingPath = findMemoryFile(projectId, context);
	if (existingPath && existingPath !== filePath) {
		const existingRaw = readFileSync(existingPath, "utf-8");
		const { meta: existingMeta } = parseFrontmatter(existingRaw);
		const oldRev = typeof existingMeta.revision === "number" ? existingMeta.revision : 1;
		pendingArchives.push({
			raw: existingRaw,
			targetPath: getHistoryPath(existingPath, oldRev),
			extraMeta: { superseded_by: context, superseded_reason: "context_moved" },
			removeOriginalPath: existingPath,
		});
		archived.push(existingPath);
	}

	// Snapshot consolidado: versão atual (se existir) vai para .history/ e a
	// nova substitui o ativo. mode "append" (legado) é tratado como
	// consolidate — toda escrita é a reescrita do estado atual.
	let revision = 1;
	let created = today;
	let existingTags: string[] = [];
	let existingEvidence: string[] = [];
	let existingSummary: string | null = null;
	let existed = false;
	if (existsSync(filePath)) {
		const existing = readFileSync(filePath, "utf-8");
		const { meta } = parseFrontmatter(existing);
		const oldRevision = typeof meta.revision === "number" ? meta.revision : 1;
		created = typeof meta.created === "string" ? meta.created : today;
		existingTags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
		existingEvidence = Array.isArray(meta.evidence) ? (meta.evidence as string[]) : [];
		existingSummary = typeof meta.summary === "string" ? meta.summary : null;
		pendingArchives.push({
			raw: existing,
			targetPath: getHistoryPath(filePath, oldRevision),
			extraMeta: { superseded_by: context, superseded_reason: "consolidated" },
			removeOriginalPath: null, // o rename substitui o ativo — nada a remover
		});
		archived.push(filePath);
		revision = oldRevision + 1;
		existed = true;
	}

	const mergedTags = [...new Set([...existingTags, ...tags])];
	const mergedEvidence = [...new Set([...existingEvidence, ...evidence])];

	const metaOut: Record<string, unknown> = {
		context,
		type,
		scope,
		revision,
		created,
		updated: today,
		// Snapshot: confiança desta versão (quem salva decide). Decay é
		// reaplicado depois via memory_decay quando necessário.
		confidence,
	};
	if (mergedTags.length > 0) metaOut.tags = mergedTags;
	// Summary reflete o estado ATUAL: sobrescreve quando fornecido; preserva
	// o anterior quando omitido (dedup futuro não pode perder o resumo).
	if (summary) metaOut.summary = summary;
	else if (existingSummary !== null) metaOut.summary = existingSummary;
	if (mergedEvidence.length > 0) metaOut.evidence = mergedEvidence;

	// Ordem segura: (1) cópias de arquivo (não tocam os originais) → (2)
	// substituição ATÔMICA do snapshot ativo → (3) remoção de originais de
	// OUTRAS chaves. Falha em qualquer passo deixa o estado consistente e a
	// operação retentável (nenhum snapshot ativo some).
	for (const a of pendingArchives) {
		archiveContent(a.raw, a.targetPath, a.extraMeta);
	}
	const body = `# ${title}\n\n${content.trim()}\n`;
	writeFileAtomic(filePath, formatFrontmatter(metaOut) + body);
	for (const a of pendingArchives) {
		// Guarda do caso supersedes === context (self-supersede): o original
		// É o snapshot recém-escrito — removê-lo apagaria a memória nova.
		if (a.removeOriginalPath && a.removeOriginalPath !== filePath) {
			rmSync(a.removeOriginalPath, { force: true });
		}
	}

	return {
		action: existed ? "consolidated" : "created",
		file: filePath,
		revision,
		archived,
	};
}

/* ------------------------------------------------------------------ */
/* Migração de memórias legadas (v1 append → snapshot v2)              */
/* ------------------------------------------------------------------ */

/**
 * Converte UMA memória do formato legado v1 (append com entradas
 * `## [data] Título`) para o snapshot v2. Idempotente: arquivo já v2
 * (frontmatter com revision) ou sem entradas datadas → no-op (false).
 *
 * O arquivo v1 INTEIRO é arquivado em .history/{...}/v0.md (revisão
 * baseline) e o path ativo é reescrito como snapshot v2 com a ÚLTIMA
 * entrada como estado atual. Retorna true quando migrou.
 */
export function migrateMemoryToSnapshot(filePath: string): boolean {
	const content = readFileSync(filePath, "utf-8");
	const { meta, body } = parseFrontmatter(content);
	if (typeof meta.revision === "number") return false; // já v2

	const headerRe = /^## \[[^\]]+\]\s+.+$/gm;
	const matches = [...body.matchAll(headerRe)];
	if (matches.length === 0) return false; // sem entradas datadas — não é v1

	const last = matches[matches.length - 1];
	const lastTitle = last[0].replace(/^## \[[^\]]+\]\s+/, "").trim();
	const lastDate = last[0].match(/^## \[([^\]]+)\]/)?.[1]?.trim() ?? "";
	const lastContent = body
		.slice((last.index ?? 0) + last[0].length)
		.replace(/^confidence:.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!lastTitle || !lastContent) return false;

	// Cópia do v1 inteiro como revisão baseline — escrita ANTES da
	// substituição atômica (Bloqueador 4): se o snapshot novo falhar, o
	// ativo continua v1 e a migração é retentável (idempotente).
	archiveContent(content, getHistoryPath(filePath, 0), {
		superseded_by: typeof meta.context === "string" ? meta.context : "",
		superseded_reason: "migrated_to_snapshot_v2",
	});

	const today = new Date().toISOString().slice(0, 10);
	const metaOut: Record<string, unknown> = {
		context: typeof meta.context === "string" ? meta.context : basename(filePath, ".md"),
		type: typeof meta.type === "string" ? meta.type : "",
		scope: filePath.includes("/_global/") ? "global" : "project",
		revision: 1,
		created: typeof meta.created === "string" ? meta.created : lastDate || today,
		updated: today,
		confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
	};
	if (Array.isArray(meta.tags)) metaOut.tags = meta.tags;
	if (typeof meta.summary === "string") metaOut.summary = meta.summary;

	writeFileAtomic(filePath, formatFrontmatter(metaOut) + `# ${lastTitle}\n\n${lastContent}\n`);
	return true;
}

/**
 * Varre global + projeto atual e migra memórias v1 → snapshot v2.
 * Idempotente (v2 pulado) e tolerante a arquivos corrompidos (pula e
 * segue). Retorna quantas migrou. Chamada no session_start antes do sync
 * do índice — o FTS já lê o formato v2.
 */
export function migrateLegacyMemories(projectId: string): number {
	let migrated = 0;
	for (const scope of ["global", "project"] as const) {
		for (const type of MEMORY_TYPES) {
			const dir =
				scope === "global"
					? join(MEMORIES_ROOT, "_global", type)
					: join(MEMORIES_ROOT, "projects", projectId, type);
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				try {
					if (migrateMemoryToSnapshot(join(dir, f))) migrated++;
				} catch {
					// arquivo corrompido — não bloqueia a migração do restante
				}
			}
		}
	}
	return migrated;
}
