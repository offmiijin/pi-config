/**
 * pi-memory — MemoryActivityStore: banco de atividade de retenção.
 *
 * `.retention.sqlite` guarda o histórico de USO das memórias (last_used_at,
 * use_count, retention_score) — dado derivado e reconstruível. O markdown
 * continua canônico: nenhuma operação aqui escreve nos arquivos de memória
 * (gravar por leitura geraria escrita por busca, conflito entre sessões e
 * poluição de .history/).
 *
 * O banco é compartilhado entre sessões (WAL + busy_timeout): reconciliar e
 * recomputar são operações idempotentes/comutativas — duas sessões rodando
 * sweep ao mesmo tempo não corrompem nem duplicam decay.
 *
 * Runtime: mesmo driver do índice (node:sqlite sob Node, bun:sqlite sob
 * Bun) — ver ../db.ts.
 */

import { chmodSync, existsSync } from "node:fs";

import { RETENTION_DB_PATH, type RetentionPolicy } from "../constants.ts";
import { DatabaseCtor, type DatabaseLike } from "../db.ts";
import { computeRetentionScore, idleDays, type RetentionComputeOpts } from "./retention.ts";

export const RETENTION_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_activity (
  memory_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT,
  type TEXT NOT NULL,
  context TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  retention_score REAL NOT NULL DEFAULT 1.0,
  last_decay_at TEXT,
  policy TEXT NOT NULL DEFAULT 'normal',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_project ON memory_activity(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_active ON memory_activity(active);
CREATE INDEX IF NOT EXISTS idx_activity_score ON memory_activity(retention_score);
CREATE TABLE IF NOT EXISTS retention_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Documento ativo que o store precisa conhecer (reconcile). */
export interface ActiveDoc {
	memoryId: string;
	/** Caminho relativo a MEMORIES_ROOT. */
	path: string;
	scope: "global" | "project";
	projectId: string | null;
	type: string;
	context: string;
	policy: RetentionPolicy;
}

export interface ActivityRecord {
	memoryId: string;
	path: string;
	scope: "global" | "project";
	projectId: string | null;
	type: string;
	context: string;
	firstSeenAt: string;
	lastUsedAt: string | null;
	useCount: number;
	retentionScore: number;
	lastDecayAt: string | null;
	policy: RetentionPolicy;
	active: boolean;
	updatedAt: string;
}

export interface ReconcileStats {
	added: number;
	updated: number;
	deactivated: number;
	skipped: number;
}

export interface SweepStats {
	/** Linhas ativas avaliadas (global + projeto alvo). */
	evaluated: number;
	/** Linhas cujo score foi RECALCULADO (mudou ou não). */
	recomputed: number;
	/** Linhas cujo score EFETIVAMENTE diminuiu neste sweep. */
	decayed: number;
	/** Linhas protegidas puladas. */
	protectedCount: number;
	lastSweepAt: string;
}

export interface RetentionMetrics {
	tracked: number;
	neverUsed: number;
	protectedCount: number;
	/** Rows com score no piso (candidatas a atenção). */
	lowRetention: number;
	lastSweepAt: string | null;
}

/** Resultado de recordAccess. */
export interface AccessResult {
	recorded: boolean;
	useCount: number;
}

export class MemoryActivityStore {
	private db: DatabaseLike | null = null;
	private opened = false;
	readonly dbPath: string;

	constructor(dbPath: string = RETENTION_DB_PATH) {
		this.dbPath = dbPath;
	}

	get isOpen(): boolean {
		return this.opened;
	}

	/**
	 * Abre o banco, aplica pragmas (WAL, busy_timeout) e garante o schema.
	 * Falha fecha o handle e relança — o chamador degrada (sem retenção).
	 */
	open(): void {
		if (this.isOpen) return;
		const db = new DatabaseCtor(this.dbPath);
		try {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("PRAGMA foreign_keys = ON");
			this.db = db;
			this.ensureSchema();
		} catch (err) {
			try {
				db.close();
			} catch {
				// close best-effort — handle não pode vazar
			}
			this.db = null;
			throw err;
		}
		this.restrictDbFiles();
		this.opened = true;
		const v = this.getMeta("schema_version");
		if (v === null) this.setMeta("schema_version", String(RETENTION_SCHEMA_VERSION));
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.opened = false;
	}

	/** Reconcile: espelha os arquivos ativos (global + projeto) no banco. */
	reconcile(docs: ActiveDoc[], projectId: string, now: Date = new Date()): ReconcileStats {
		const db = this.requireDb();
		const nowIso = now.toISOString();
		const stats: ReconcileStats = { added: 0, updated: 0, deactivated: 0, skipped: 0 };

		const existing = new Map<
			string,
			{ path: string; active: boolean; firstSeenAt: string }
		>(
			(
				db.prepare(
					"SELECT memory_id, path, active, first_seen_at FROM memory_activity WHERE scope = 'global' OR project_id = ?",
				).all(projectId) as {
					memory_id: string;
					path: string;
					active: number;
					first_seen_at: string;
				}[]
			).map((r) => [
				r.memory_id,
				{ path: r.path, active: r.active === 1, firstSeenAt: r.first_seen_at },
			]),
		);

		const upsert = db.prepare(
			`INSERT INTO memory_activity
			   (memory_id, path, scope, project_id, type, context, policy,
			    first_seen_at, active, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
			 ON CONFLICT(memory_id) DO UPDATE SET
			   path=excluded.path, scope=excluded.scope, project_id=excluded.project_id,
			   type=excluded.type, context=excluded.context, policy=excluded.policy,
			   active=1, updated_at=excluded.updated_at`,
		);

		for (const doc of docs) {
			try {
				const prev = existing.get(doc.memoryId);
				upsert.run(
					doc.memoryId,
					doc.path,
					doc.scope,
					doc.projectId,
					doc.type,
					doc.context,
					doc.policy,
					// Primeira vez nunca é sobrescrito (continuação da identidade).
					prev?.firstSeenAt ?? nowIso,
					nowIso,
				);
				if (prev === undefined) stats.added++;
				else stats.updated++;
			} catch (err) {
				stats.skipped++;
				console.warn(
					`[pi-memory] retention reconcile: pulou ${doc.path}: ${(err as Error).message}`,
				);
			}
		}

		// Desativa linhas de global/projeto que não estão mais em disco
		// (memória movida para .supersedes/ ou arquivo removido). Linhas de
		// OUTROS projetos ficam intactas (banco compartilhado).
		const activePaths = docs.map((d) => d.path);
		if (activePaths.length === 0) {
			const r = db
				.prepare(
					"UPDATE memory_activity SET active = 0, updated_at = ? WHERE active = 1 AND (scope = 'global' OR project_id = ?)",
				)
				.run(nowIso, projectId);
			stats.deactivated += Number(r.changes);
		} else {
			const placeholders = activePaths.map(() => "?").join(",");
			const r = db
				.prepare(
					`UPDATE memory_activity SET active = 0, updated_at = ? WHERE active = 1 AND (scope = 'global' OR project_id = ?) AND path NOT IN (${placeholders})`,
				)
				.run(nowIso, projectId, ...activePaths);
			stats.deactivated += Number(r.changes);
		}

		return stats;
	}

	/**
	 * Registra uso de uma memória (chamado pela memory_search). Atualiza
	 * last_used_at, incrementa use_count e RESETA o score para 1.0. Linha
	 * desconhecida (memória criada após o último reconcile) → recorded=false
	 * (o próximo sweep/reconcile absorve; a busca não quebra).
	 */
	recordAccess(
		memoryId: string | null,
		path: string,
		now: Date = new Date(),
	): AccessResult {
		const db = this.requireDb();
		const nowIso = now.toISOString();

		const row = memoryId
			? (db
					.prepare("SELECT memory_id, path, use_count, active FROM memory_activity WHERE memory_id = ?")
					.get(memoryId) as { memory_id: string; use_count: number; active: number } | undefined)
			: (db
					.prepare("SELECT memory_id, use_count, active FROM memory_activity WHERE path = ?")
					.get(path) as { memory_id: string; use_count: number; active: number } | undefined);

		if (!row || row.active !== 1) return { recorded: false, useCount: 0 };

		db.prepare(
			"UPDATE memory_activity SET last_used_at = ?, use_count = use_count + 1, retention_score = 1.0, updated_at = ? WHERE memory_id = ?",
		).run(nowIso, nowIso, row.memory_id);
		return { recorded: true, useCount: row.use_count + 1 };
	}

	/**
	 * Sweep: recalcula o retention_score de todas as linhas ativas
	 * (global + projeto alvo) pela fórmula de meia-vida. Memórias
	 * `protected` são puladas. Nunca altera markdown nem confidence.
	 */
	recompute(projectId: string, now: Date = new Date(), opts: RetentionComputeOpts = {}): SweepStats {
		const db = this.requireDb();
		const nowIso = now.toISOString();
		const rows = db
			.prepare(
				"SELECT memory_id, path, last_used_at, first_seen_at, retention_score, policy FROM memory_activity WHERE active = 1 AND (scope = 'global' OR project_id = ?)",
			)
			.all(projectId) as {
			memory_id: string;
			path: string;
			last_used_at: string | null;
			first_seen_at: string;
			retention_score: number;
			policy: string;
		}[];

		const stats: SweepStats = {
			evaluated: rows.length,
			recomputed: 0,
			decayed: 0,
			protectedCount: 0,
			lastSweepAt: nowIso,
		};

		const update = db.prepare(
			"UPDATE memory_activity SET retention_score = ?, last_decay_at = ?, updated_at = ? WHERE memory_id = ?",
		);

		for (const row of rows) {
			if (row.policy === "protected") {
				stats.protectedCount++;
				continue;
			}
			const score = computeRetentionScore(
				idleDays(now, row.last_used_at, row.first_seen_at),
				opts,
			);
			if (Math.abs(score - row.retention_score) > 1e-9) {
				update.run(score, nowIso, nowIso, row.memory_id);
				if (score < row.retention_score) stats.decayed++;
			}
			stats.recomputed++;
		}

		this.setMeta("last_sweep_at", nowIso);
		return stats;
	}

	/** Mapa path → retention_score das linhas ativas (para aplicar no índice). */
	listScoresByPath(projectId: string): Map<string, number> {
		const db = this.requireDb();
		const rows = db
			.prepare(
				"SELECT path, retention_score FROM memory_activity WHERE active = 1 AND (scope = 'global' OR project_id = ?)",
			)
			.all(projectId) as { path: string; retention_score: number }[];
		return new Map(rows.map((r) => [r.path, r.retention_score]));
	}

	/** Registros ativos de global + projeto (para tool/preview/status). */
	listActiveRecords(projectId: string): ActivityRecord[] {
		const db = this.requireDb();
		const rows = db
			.prepare(
				"SELECT memory_id, path, scope, project_id, type, context, first_seen_at, last_used_at, use_count, retention_score, last_decay_at, policy, active, updated_at FROM memory_activity WHERE active = 1 AND (scope = 'global' OR project_id = ?)",
			)
			.all(projectId) as Record<string, unknown>[];
		return rows.map((r) => ({
			memoryId: String(r.memory_id),
			path: String(r.path),
			scope: r.scope as "global" | "project",
			projectId: r.project_id === null ? null : String(r.project_id),
			type: String(r.type),
			context: String(r.context),
			firstSeenAt: String(r.first_seen_at),
			lastUsedAt: r.last_used_at === null ? null : String(r.last_used_at),
			useCount: Number(r.use_count),
			retentionScore: Number(r.retention_score),
			lastDecayAt: r.last_decay_at === null ? null : String(r.last_decay_at),
			policy: r.policy as RetentionPolicy,
			active: Number(r.active) === 1,
			updatedAt: String(r.updated_at),
		}));
	}

	/** Métricas para memory_status / memory_retention status. */
	getMetrics(projectId: string): RetentionMetrics {
		const records = this.listActiveRecords(projectId);
		return {
			tracked: records.length,
			neverUsed: records.filter((r) => r.lastUsedAt === null).length,
			protectedCount: records.filter((r) => r.policy === "protected").length,
			lowRetention: records.filter((r) => r.retentionScore <= 0.1).length,
			lastSweepAt: this.getMeta("last_sweep_at"),
		};
	}

	getMeta(key: string): string | null {
		const db = this.requireDb();
		const row = db
			.prepare("SELECT value FROM retention_meta WHERE key = ?")
			.get(key) as { value: string } | undefined;
		return row ? row.value : null;
	}

	setMeta(key: string, value: string): void {
		this.requireDb()
			.prepare(
				"INSERT INTO retention_meta (key, value) VALUES (?, ?) " +
					"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value);
	}

	private ensureSchema(): void {
		this.requireDb().exec(SCHEMA_SQL);
	}

	private requireDb(): DatabaseLike {
		if (!this.db) throw new Error("MemoryActivityStore não está aberto — chame open() antes.");
		return this.db;
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
