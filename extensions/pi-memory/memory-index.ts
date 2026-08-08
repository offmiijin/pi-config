/**
 * pi-memory — Índice SQLite FTS5/BM25 sobre os arquivos markdown ativos.
 *
 * O markdown continua sendo a fonte da verdade; o SQLite é um índice derivado,
 * descartável e reconstruível. Nenhuma operação de memória escreve pelo banco.
 *
 * Runtime: a extensão roda in-process no pi. O pi é distribuído como binário
 * Bun (ELF compilado) e como pacote npm (Node). O driver SQLite é resolvido
 * em runtime: `node:sqlite` (DatabaseSync) quando roda sob Node — nativo, sem
 * dependência npm — e `bun:sqlite` (Database) quando roda sob Bun, pois o Bun
 * não implementa `node:sqlite`. As APIs são equivalentes para a superfície
 * usada aqui (prepare/run/get/all/exec/close). O acesso ao banco fica
 * isolado nesta classe.
 *
 * Estrutura:
 *   memories/.index.sqlite            — banco único (global + todos os projetos)
 *   memory_documents                  — metadados por arquivo (1 linha = 1 .md ativo)
 *   memory_fts                        — FTS5 (title, summary, tags, body, norm), rowid = doc id
 *   index_meta                        — schema_version, rebuilt_at
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT, MEMORY_TYPES } from "./constants.ts";
import { extractLastEntryTitle, parseFrontmatter } from "./memory.ts";
import { DatabaseCtor, type DatabaseLike, type StatementLike } from "./db.ts";

export const INDEX_DB_FILENAME = ".index.sqlite";
export const INDEX_DB_PATH = join(MEMORIES_ROOT, INDEX_DB_FILENAME);
export const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT,
  type TEXT NOT NULL,
  context TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL,
  updated TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_scope_project ON memory_documents(scope, project_id);
CREATE INDEX IF NOT EXISTS idx_docs_type ON memory_documents(type);
CREATE INDEX IF NOT EXISTS idx_docs_confidence ON memory_documents(confidence);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON memory_documents(updated);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, summary, tags, body, norm,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Um documento indexável, normalizado a partir de um arquivo markdown ativo. */
export interface IndexDocument {
	/** Caminho relativo a MEMORIES_ROOT (ex: "_global/gotchas/x.md"). */
	path: string;
	scope: "global" | "project";
	projectId: string | null;
	type: string;
	context: string;
	title: string;
	summary: string | null;
	tags: string[];
	confidence: number;
	updated: string;
	/** Corpo limpo: sem frontmatter, sem cabeçalhos de entrada, sem linhas confidence:. */
	body: string;
	contentHash: string;
}

/** SHA-256 hex do conteúdo bruto do arquivo (detecção de edição manual). */
export function hashContent(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

function stripMd(name: string): string {
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * Deriva escopo/projeto/tipo/contexto do caminho relativo.
 * Layout: "_global/<type>/<context>.md" | "projects/<projectId>/<type>/<context>.md".
 */
export function inferFromRelPath(relPath: string): {
	scope: "global" | "project";
	projectId: string | null;
	type: string;
	context: string;
} {
	const parts = relPath.split("/");
	if (parts[0] === "_global" && parts.length === 3) {
		return { scope: "global", projectId: null, type: parts[1], context: stripMd(parts[2]) };
	}
	if (parts[0] === "projects" && parts.length === 4) {
		return {
			scope: "project",
			projectId: parts[1],
			type: parts[2],
			context: stripMd(parts[3]),
		};
	}
	throw new Error(`Caminho de memória não reconhecido: "${relPath}"`);
}

/** Corpo limpo para indexação FTS (mesma limpeza do excerpt, sem truncar). */
export function cleanBody(body: string): string {
	return body
		.replace(/^## \[[^\]]+\][^\n]*\n/gm, "")
		.replace(/^confidence:.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Texto normalizado para busca por componentes de identificador (coluna
 * `norm`): `_`, `-`, `/`, `.` viram espaços (colapsados). A coluna original
 * mantém o token exato (ex.: id_snake_case inteiro); a `norm` permite
 * encontrar "snake" e "case" isolados, com peso menor no BM25 — um match
 * no campo real sempre rankeia acima.
 */
export function normalizeForSearch(
	title: string,
	summary: string | null,
	tags: string[],
	body: string,
): string {
	return [title, summary ?? "", tags.join(" "), body]
		.join(" ")
		.replace(/[_\-/.]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Monta uma query FTS5 a partir de termos crus (OR entre termos).
 * FTS5 não tem escape por barra invertida — cada termo vira uma frase
 * entre aspas (aspas internas duplicadas) com `*` no último token, que dá
 * matching por PREFIXO de token (NÃO substring — um termo só casa token
 * que começa com ele). Componentes internos de identificador (ex.: "snake"
 * em id_snake_case) são encontráveis pela coluna `norm` (separadores viram
 * espaços; peso menor no BM25).
 */
export function buildFtsQuery(terms: string[]): string {
	const parts: string[] = [];
	for (const raw of terms) {
		const term = raw.trim();
		if (!term) continue;
		parts.push(`"${term.replace(/"/g, '""')}"*`);
	}
	return parts.join(" OR ");
}

export interface IndexSearchOptions {
	/** Termos crus — OR entre eles; termo com espaço vira frase. */
	terms: string[];
	scope?: "global" | "project" | "all";
	/** Obrigatório para scope=project/all (como no search via rg). */
	projectId?: string;
	type?: string;
	minConfidence?: number;
	limit?: number;
}

export interface IndexSearchResult {
	/** Caminho relativo a MEMORIES_ROOT. */
	path: string;
	scope: "global" | "project";
	projectId: string | null;
	type: string;
	context: string;
	title: string;
	summary: string | null;
	confidence: number;
	updated: string;
	/** Trecho relevante (coluna body), vazio quando o corpo é vazio. */
	snippet: string;
	/** Maior = melhor (BM25 ponderado — apenas lexical; metadados não entram). */
	score: number;
}

/**
 * Lista arquivos markdown ativos (global + projeto atual), relativos a root.
 * Exclui sessions/ e .supersedes/ por construção — só varre os diretórios de tipo.
 */
export function listActiveMemoryFiles(
	projectId: string,
	root: string = MEMORIES_ROOT,
): string[] {
	const out: string[] = [];
	for (const type of MEMORY_TYPES) {
		for (const scope of ["global", "project"] as const) {
			const base =
				scope === "global"
					? join(root, "_global", type)
					: join(root, "projects", projectId, type);
			if (!existsSync(base)) continue;
			for (const f of readdirSync(base)) {
				if (!f.endsWith(".md")) continue;
				out.push(
					scope === "global"
						? `_global/${type}/${f}`
						: `projects/${projectId}/${type}/${f}`,
				);
			}
		}
	}
	return out.sort();
}

/** Lê e normaliza um arquivo markdown ativo em IndexDocument. */
export function readMemoryDocFromFile(absPath: string, relPath: string): IndexDocument {
	const raw = readFileSync(absPath, "utf-8");
	const { meta, body } = parseFrontmatter(raw);
	const { scope, projectId, type, context } = inferFromRelPath(relPath);
	const tags = Array.isArray(meta.tags)
		? (meta.tags as unknown[]).filter((t): t is string => typeof t === "string")
		: [];
	return {
		path: relPath,
		scope,
		projectId,
		type,
		context,
		title: extractLastEntryTitle(body) ?? context,
		summary: typeof meta.summary === "string" ? meta.summary : null,
		tags,
		confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
		updated: typeof meta.updated === "string" ? meta.updated : "",
		body: cleanBody(body),
		contentHash: hashContent(raw),
	};
}

export interface RebuildStats {
	projectId: string;
	/** Documentos inseridos/atualizados no rebuild. */
	added: number;
	/** Documentos antigos de global/projeto alvo removidos. */
	removed: number;
	/** Arquivos que falharam ao ler (corrompidos/removidos no meio) — pulados. */
	skipped: number;
	rebuiltAt: string;
	dbPath: string;
}

export interface SyncStats {
	added: number;
	updated: number;
	removed: number;
	skipped: number;
}

/** Resultado de syncMutationSafe — nunca lança, sempre retorna { ok }. */
export interface SyncMutationResult {
	ok: boolean;
	error?: string;
}

/** Caminho relativo a MEMORIES_ROOT a partir de um path absoluto. */
export function relFromMemoriesRoot(absPath: string): string {
	const prefix = MEMORIES_ROOT + "/";
	return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

export class MemoryIndex {
	private db: DatabaseLike | null = null;
	private opened = false;
	/** Banco novo ou schema antigo — precisa de rebuild antes de servir buscas. */
	needsRebuild = false;
	readonly dbPath: string;
	readonly memoriesRoot: string;

	constructor(dbPath: string = INDEX_DB_PATH, memoriesRoot: string = MEMORIES_ROOT) {
		this.dbPath = dbPath;
		this.memoriesRoot = memoriesRoot;
	}

	get isOpen(): boolean {
		return this.opened;
	}

	/**
	 * Abre o banco, aplica pragmas (WAL, busy_timeout), cria o schema e valida
	 * FTS5. Banco novo ⇒ needsRebuild = true (quem chama decide quando).
	 * Versão de schema ANTIGA ⇒ migra: recria a tabela FTS com a estrutura
	 * atual e reindexa TODOS os docs a partir do markdown (fonte da verdade),
	 * preservando docs de outros projetos. Falha de migração fecha o banco e
	 * relança — o chamador cai no fallback rg.
	 */
	open(): void {
		if (this.isOpen) return;

		const db = new DatabaseCtor(this.dbPath);
		try {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("PRAGMA foreign_keys = ON");
			this.db = db;

			// Probe definitivo: se FTS5 não estiver compilado, a criação da tabela
			// virtual lança "no such module: fts5".
			this.ensureSchema();
		} catch (err) {
			// Handle aberto não pode vazar — fecha antes de descartar
			// (libera lock/WAL; close best-effort).
			try {
				db.close();
			} catch {
				// close não é crítico — descartado a seguir
			}
			this.db = null;
			const msg = (err as Error).message ?? String(err);
			if (/no such module: fts5/i.test(msg)) {
				throw new Error(
					"SQLite deste runtime não tem FTS5 compilado. Node (node:sqlite) e Bun " +
						"(bun:sqlite) embutem SQLite com FTS5 habilitado por padrão; se o " +
						"binário for customizado, verifique o SQLite compilado.",
				);
			}
			throw err;
		}
		this.restrictDbFiles();
		this.opened = true;

		const version = this.getMeta("schema_version");
		if (version !== null && Number(version) !== SCHEMA_VERSION) {
			try {
				this.migrateSchema(Number(version));
			} catch (err) {
				// Rollback aplicado na migração — banco fechado; chamador cai no rg.
				this.close();
				throw err;
			}
			this.setMeta("schema_version", String(SCHEMA_VERSION));
			this.setMeta("rebuilt_at", new Date().toISOString());
			this.needsRebuild = false;
		} else {
			this.needsRebuild = version === null || Number(version) !== SCHEMA_VERSION;
		}
	}

	/**
	 * Migra um banco de versão antiga: recria a tabela FTS (estrutura pode ter
	 * mudado — ex.: coluna `norm` do v2) e reindexa TODOS os docs de
	 * memory_documents a partir do markdown, em transação única. Arquivo
	 * ausente/ilegível ⇒ doc removido (índice derivado; markdown é canônico).
	 * Falha ⇒ ROLLBACK (banco volta ao estado antigo) e relança.
	 */
	private migrateSchema(_oldVersion: number): void {
		const db = this.requireDb();
		db.exec("BEGIN");
		try {
			db.exec("DROP TABLE IF EXISTS memory_fts");
			this.ensureSchema();

			const rows = db
				.prepare("SELECT id, path FROM memory_documents")
				.all() as { id: number | bigint; path: string }[];
			const now = new Date().toISOString();
			for (const row of rows) {
				const abs = join(this.memoriesRoot, row.path);
				if (!existsSync(abs)) {
					db.prepare("DELETE FROM memory_documents WHERE id = ?").run(row.id);
					continue;
				}
				try {
					this.upsertDocAndFts(db, readMemoryDocFromFile(abs, row.path), now);
				} catch (err) {
					// Arquivo ilegível — remove do índice (consistência doc × FTS).
					console.warn(`[pi-memory] migrate: pulou ${row.path}: ${(err as Error).message}`);
					db.prepare("DELETE FROM memory_documents WHERE id = ?").run(row.id);
				}
			}
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.opened = false;
	}

	/** Lê valor de index_meta (null se ausente). */
	getMeta(key: string): string | null {
		const db = this.requireDb();
		const row = db
			.prepare("SELECT value FROM index_meta WHERE key = ?")
			.get(key) as { value: string } | null | undefined;
		return row ? row.value : null;
	}

	/**
	 * Rebuild completo de global + projeto atual dentro de uma transação.
	 * Só mexe em documentos de global/projeto alvo — docs de OUTROS projetos
	 * ficam intactos (o banco é compartilhado entre projetos).
	 */
	rebuild(projectId: string): RebuildStats {
		const db = this.requireDb();
		const files = listActiveMemoryFiles(projectId, this.memoriesRoot);
		const now = new Date().toISOString();

		const delFtsById = db.prepare("DELETE FROM memory_fts WHERE rowid = ?");

		let removed = 0;
		let added = 0;
		let skipped = 0;

		db.exec("BEGIN");
		try {
			// Limpa global + projeto alvo (FTS primeiro — FK lógica por rowid).
			const stale = db
				.prepare("SELECT id FROM memory_documents WHERE scope = 'global' OR project_id = ?")
				.all(projectId) as { id: number | bigint }[];
			for (const row of stale) {
				delFtsById.run(row.id);
				removed++;
			}
			db.prepare("DELETE FROM memory_documents WHERE scope = 'global' OR project_id = ?").run(
				projectId,
			);

			// Indexa os arquivos ativos. Arquivo ilegível não derruba o rebuild.
			for (const rel of files) {
				try {
					const doc = readMemoryDocFromFile(join(this.memoriesRoot, rel), rel);
					this.upsertDocAndFts(db, doc, now);
					added++;
				} catch (err) {
					skipped++;
					console.warn(`[pi-memory] rebuild: pulou ${rel}: ${(err as Error).message}`);
				}
			}

			this.setMeta("schema_version", String(SCHEMA_VERSION));
			this.setMeta("rebuilt_at", now);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}

		this.needsRebuild = false;
		this.restrictDbFiles();
		return { projectId, added, removed, skipped, rebuiltAt: now, dbPath: this.dbPath };
	}

	/** Insere ou atualiza um documento (doc + FTS) em transação própria. */
	upsertDocument(doc: IndexDocument): void {
		const db = this.requireDb();
		db.exec("BEGIN");
		try {
			this.upsertDocAndFts(db, doc, new Date().toISOString());
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Upsert em lote numa única transação (usado por memory_extract). */
	syncDocuments(docs: IndexDocument[]): void {
		if (docs.length === 0) return;
		const db = this.requireDb();
		const now = new Date().toISOString();
		db.exec("BEGIN");
		try {
			for (const doc of docs) this.upsertDocAndFts(db, doc, now);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * Aplica uma mutação de escrita numa única transação (memory_save/memory_extract):
	 * remove paths arquivados (.supersedes/) e faz upsert dos documentos ativos.
	 * Path presente nos DOIS conjuntos (consolidate — arquivado e recriado no
	 * mesmo caminho) NÃO é removido; o upsert substitui o doc inteiro.
	 */
	syncMutation(opts: { upsert: IndexDocument[]; remove: string[] }): void {
		const { upsert, remove } = opts;
		if (upsert.length === 0 && remove.length === 0) return;
		const db = this.requireDb();
		const now = new Date().toISOString();
		const upsertPaths = new Set(upsert.map((d) => d.path));
		db.exec("BEGIN");
		try {
			for (const path of remove) {
				if (upsertPaths.has(path)) continue;
				const row = db
					.prepare("SELECT id FROM memory_documents WHERE path = ?")
					.get(path) as { id: number | bigint } | undefined;
				if (!row) continue;
				db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id);
				db.prepare("DELETE FROM memory_documents WHERE id = ?").run(row.id);
			}
			for (const doc of upsert) this.upsertDocAndFts(db, doc, now);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * Variante tolerante a falha de syncMutation — nunca lança.
	 * Falha marca needsRebuild: o índice pode estar inconsistente com o disco;
	 * a próxima busca cai no fallback rg (search bloqueia com needsRebuild) e o
	 * próximo syncIncremental reconstrói. Operação canônica (markdown) já
	 * aconteceu antes da chamada — não é revertida aqui.
	 */
	syncMutationSafe(opts: { upsert: IndexDocument[]; remove: string[] }): SyncMutationResult {
		try {
			this.syncMutation(opts);
			return { ok: true };
		} catch (err) {
			this.needsRebuild = true;
			return { ok: false, error: (err as Error).message ?? String(err) };
		}
	}

	/** Remove um documento (doc + FTS). Path inexistente é no-op. */
	removeDocument(path: string): void {
		const db = this.requireDb();
		const row = db
			.prepare("SELECT id FROM memory_documents WHERE path = ?")
			.get(path) as { id: number | bigint } | undefined;
		if (!row) return;
		db.exec("BEGIN");
		try {
			db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id);
			db.prepare("DELETE FROM memory_documents WHERE id = ?").run(row.id);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Atualiza só metadados (confiança/updated) — corpo não mudou, FTS intocado. */
	updateConfidence(path: string, confidence: number, updated: string): void {
		const db = this.requireDb();
		db.prepare(
			"UPDATE memory_documents SET confidence = ?, updated = ?, modified_at = ? WHERE path = ?",
		).run(confidence, updated, new Date().toISOString(), path);
	}

	/**
	 * Cruza disco × banco por content_hash (global + projeto alvo).
	 * - arquivo novo no disco → insere
	 * - hash divergente (edição manual fora das tools) → atualiza
	 * - path no banco sem arquivo em disco → remove
	 * Banco novo/schema antigo (needsRebuild) → rebuild completo (mais barato
	 * que diff parcial). Não mexe em docs de OUTROS projetos.
	 */
	syncIncremental(projectId: string): SyncStats {
		const db = this.requireDb();

		if (this.needsRebuild) {
			const r = this.rebuild(projectId);
			return { added: r.added, updated: 0, removed: r.removed, skipped: r.skipped };
		}

		const disk = new Map<string, IndexDocument>();
		let skipped = 0;
		for (const rel of listActiveMemoryFiles(projectId, this.memoriesRoot)) {
			try {
				disk.set(rel, readMemoryDocFromFile(join(this.memoriesRoot, rel), rel));
			} catch (err) {
				skipped++;
				console.warn(`[pi-memory] sync: pulou ${rel}: ${(err as Error).message}`);
			}
		}

		const existing = new Map(
			(
				db.prepare(
					"SELECT path, content_hash FROM memory_documents WHERE scope = 'global' OR project_id = ?",
				).all(projectId) as { path: string; content_hash: string }[]
			).map((r) => [r.path, r.content_hash]),
		);

		const now = new Date().toISOString();
		let added = 0;
		let updated = 0;
		db.exec("BEGIN");
		try {
			for (const [rel, doc] of disk) {
				const hash = existing.get(rel);
				if (hash === undefined) {
					this.upsertDocAndFts(db, doc, now);
					added++;
				} else if (hash !== doc.contentHash) {
					this.upsertDocAndFts(db, doc, now);
					updated++;
				}
			}

			let removed = 0;
			for (const path of existing.keys()) {
				if (disk.has(path)) continue;
				const row = db
					.prepare("SELECT id FROM memory_documents WHERE path = ?")
					.get(path) as { id: number | bigint } | undefined;
				if (!row) continue;
				db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id);
				db.prepare("DELETE FROM memory_documents WHERE id = ?").run(row.id);
				removed++;
			}

			db.exec("COMMIT");
			this.restrictDbFiles();
			return { added, updated, removed, skipped };
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * Busca FTS5/BM25 com filtros SQL. Ordenação por relevância LEXICAL:
	 * BM25 ponderado por coluna (título 8 > summary 4 > tags 2 > corpo 1 >
	 * norm 0.5) decide o ranking; confiança e recência entram SÓ como
	 * desempate (ORDER BY secundário), nunca como penalidade aditiva no
	 * score — um match de título antigo/confiança baixa vence um match de
	 * corpo recente/alta. A coluna `norm` (componentes de identificador)
	 * tem peso menor: match exato em campo real rankeia acima.
	 *
	 * Convenção FTS5: bm25() retorna NEGATIVO e menor (mais negativo) =
	 * mais relevante. O campo exposto `score` = -bm25 (maior = melhor),
	 * só para diagnóstico — o modelo não o consome.
	 */
	search(options: IndexSearchOptions): IndexSearchResult[] {
		const db = this.requireDb();
		if (this.needsRebuild) {
			throw new Error("Índice precisa rebuild antes da busca (needsRebuild=true).");
		}

		const { terms, scope = "all", type, minConfidence, limit = 10 } = options;
		const matchQuery = buildFtsQuery(terms);
		if (!matchQuery) return [];

		if (scope !== "global" && !options.projectId) {
			throw new Error("search: projectId é obrigatório para scope=project/all");
		}

		const params: (string | number)[] = [matchQuery];
		let scopeSql: string;
		if (scope === "global") {
			scopeSql = "d.scope = 'global'";
		} else if (scope === "project") {
			scopeSql = "d.scope = 'project' AND d.project_id = ?";
			params.push(options.projectId!);
		} else if (scope === "all") {
			scopeSql = "(d.scope = 'global' OR (d.scope = 'project' AND d.project_id = ?))";
			params.push(options.projectId!);
		} else {
			throw new Error(`search: escopo inválido "${scope}"`);
		}

		if (type) {
			scopeSql += " AND d.type = ?";
			params.push(type);
		}
		if (minConfidence !== undefined) {
			scopeSql += " AND d.confidence >= ?";
			params.push(minConfidence);
		}
		params.push(limit);

		const rows = db
			.prepare(
				`SELECT d.path, d.scope, d.project_id, d.type, d.context, d.title, d.summary,
				        d.confidence, d.updated,
				        snippet(memory_fts, 3, '', '', '…', 24) AS snippet_text,
				        -bm25(memory_fts, 8.0, 4.0, 2.0, 1.0, 0.5) AS score
				 FROM memory_fts
				 JOIN memory_documents d ON d.id = memory_fts.rowid
				 WHERE memory_fts MATCH ? AND ${scopeSql}
				 ORDER BY bm25(memory_fts, 8.0, 4.0, 2.0, 1.0, 0.5) ASC,
				          d.confidence DESC,
				          d.updated DESC,
				          d.path ASC
				 LIMIT ?`,
			)
			.all(...params) as Record<string, unknown>[];

		return rows.map((r) => ({
			path: String(r.path),
			scope: r.scope as "global" | "project",
			projectId: r.project_id === null ? null : String(r.project_id),
			type: String(r.type),
			context: String(r.context),
			title: String(r.title),
			summary: r.summary === null ? null : String(r.summary),
			confidence: Number(r.confidence),
			updated: String(r.updated),
			snippet: r.snippet_text === null ? "" : String(r.snippet_text),
			score: Number(r.score),
		}));
	}

	private requireDb(): DatabaseLike {
		if (!this.db) throw new Error("MemoryIndex não está aberto — chame open() antes.");
		return this.db;
	}

	/**
	 * Upsert do documento relacional + recriação da linha FTS (delete+insert).
	 * ON CONFLICT(path) preserva o id — a linha FTS mantém rowid = id do doc.
	 * O id é resolvido por path (nunca por lastInsertRowid — não confiável no
	 * ramo UPDATE do UPSERT; já apontou para outro documento e corrompeu o FTS).
	 */
	private upsertDocAndFts(db: DatabaseLike, doc: IndexDocument, now: string): void {
		db
			.prepare(
				`INSERT INTO memory_documents
				   (path, scope, project_id, type, context, title, summary, tags_json,
				    confidence, updated, content_hash, created_at, modified_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   scope=excluded.scope, project_id=excluded.project_id, type=excluded.type,
				   context=excluded.context, title=excluded.title, summary=excluded.summary,
				   tags_json=excluded.tags_json, confidence=excluded.confidence,
				   updated=excluded.updated, content_hash=excluded.content_hash,
				   modified_at=excluded.modified_at`,
			)
			.run(
				doc.path,
				doc.scope,
				doc.projectId,
				doc.type,
				doc.context,
				doc.title,
				doc.summary,
				JSON.stringify(doc.tags),
				doc.confidence,
				doc.updated,
				doc.contentHash,
				now,
				now,
			);

		// lastInsertRowid NÃO é confiável após UPSERT no ramo UPDATE — já retornou
		// o rowid de outro documento e corrompeu o FTS (conteúdo novo gravado no
		// FTS alheio, FTS do alvo obsoleto). Resolve o id pelo path único.
		const id = this.docIdByPath(db, doc.path);
		db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(id);
		db.prepare(
			"INSERT INTO memory_fts (rowid, title, summary, tags, body, norm) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			id,
			doc.title,
			doc.summary ?? "",
			doc.tags.join(" "),
			doc.body,
			normalizeForSearch(doc.title, doc.summary, doc.tags, doc.body),
		);
	}

	private docIdByPath(db: DatabaseLike, path: string): number {
		const row = db
			.prepare("SELECT id FROM memory_documents WHERE path = ?")
			.get(path) as { id: number | bigint } | undefined;
		if (!row) throw new Error(`Documento não encontrado no índice: ${path}`);
		return Number(row.id);
	}

	private ensureSchema(): void {
		this.requireDb().exec(SCHEMA_SQL);
	}

	private setMeta(key: string, value: string): void {
		this.requireDb()
			.prepare(
				"INSERT INTO index_meta (key, value) VALUES (?, ?) " +
					"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value);
	}

	/** db/wal/shm privados (0o600) — defesa em profundidade além do dir 0o700. */
	private restrictDbFiles(): void {
		for (const p of [this.dbPath, this.dbPath + "-wal", this.dbPath + "-shm"]) {
			if (!existsSync(p)) continue;
			try {
				chmodSync(p, 0o600);
			} catch {
				// best-effort — permissão não é crítica
			}
		}
	}
}
