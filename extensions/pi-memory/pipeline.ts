/**
 * pi-memory — Pipeline operacional de memórias (sem dependência do PI).
 *
 * Banco transacional separado do índice derivado (FTS5):
 *   memories/.pipeline.sqlite — episódios, evidências, jobs, candidatos.
 *
 * O markdown de memórias e o `.index.sqlite` (busca) NÃO são tocados aqui —
 * o pipeline registra o que a sessão produziu para o worker de extração
 * (fases seguintes). A fonte original continua sendo a sessão JSONL do Pi;
 * este banco guarda apenas a projeção operacional.
 *
 * Fase 0: schema completo + captura de episódios (agent_settled). As tabelas
 * de evidências/jobs/candidatos já nascem para as fases 1–4; só episódios
 * são populados nesta fase.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT } from "./constants.ts";
import { DatabaseCtor, type DatabaseLike } from "./db.ts";
import { estimateTokens } from "./session.ts";

/** Nome do banco do pipeline dentro de MEMORIES_ROOT. */
export const PIPELINE_DB_FILENAME = ".pipeline.sqlite";
export const PIPELINE_DB_PATH = join(MEMORIES_ROOT, PIPELINE_DB_FILENAME);
export const PIPELINE_SCHEMA_VERSION = 1;

/** Status de episódio (ciclo: pending → normalized → processed | ignored | failed). */
export const EPISODE_STATUS = {
	PENDING: "pending",
	NORMALIZED: "normalized",
	IGNORED: "ignored",
	PROCESSED: "processed",
	FAILED: "failed",
} as const;
export type EpisodeStatus = (typeof EPISODE_STATUS)[keyof typeof EPISODE_STATUS];

/** Status de job de extração (ciclo: queued → processing → done | retry | dead_letter). */
export const JOB_STATUS = {
	QUEUED: "queued",
	PROCESSING: "processing",
	VALIDATING: "validating",
	COMMITTING: "committing",
	DONE: "done",
	RETRY: "retry",
	DEAD_LETTER: "dead_letter",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** Status de candidato (memória proposta pelo modelo). */
export const CANDIDATE_STATUS = {
	PENDING: "pending",
	COMMITTED: "committed",
	REJECTED: "rejected",
} as const;
export type CandidateStatus = (typeof CANDIDATE_STATUS)[keyof typeof CANDIDATE_STATUS];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  start_entry_id TEXT NOT NULL,
  end_entry_id TEXT NOT NULL,
  leaf_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  eligibility_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_session_fp ON episodes(session_id, fingerprint);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  entry_id TEXT,
  tool_call_id TEXT,
  kind TEXT NOT NULL,
  tool_name TEXT,
  payload_json TEXT,
  content_hash TEXT,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  redaction_flags INTEGER NOT NULL DEFAULT 0,
  is_error INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evidence_episode ON evidence(episode_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  prompt_version INTEGER,
  model TEXT,
  reasoning_level TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, project_id);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  action TEXT NOT NULL,
  context TEXT NOT NULL,
  type TEXT,
  scope TEXT,
  title TEXT,
  summary TEXT,
  content TEXT,
  confidence REAL,
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  supersedes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_job ON candidates(job_id);

CREATE TABLE IF NOT EXISTS pipeline_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Gera id curto e legível com prefixo (ep_, ev_, job_, cand_). */
export function newPipelineId(prefix: string): string {
	return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Forma mínima de entrada de sessão usada pelo pipeline (subset do
 * SessionEntry do Pi — só o que a estimativa de tokens precisa).
 */
export interface EpisodeEntryLike {
	type: string;
	id: string;
	message?: {
		role?: string;
		content?: unknown;
		command?: string;
		output?: string;
	};
	summary?: string;
	content?: unknown;
}

/** Estima tokens de um bloco de conteúdo (text + toolCall arguments). */
function estimateContentTokens(content: unknown): number {
	if (typeof content === "string") return estimateTokens(content);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") total += estimateTokens(b.text);
		else if (b.type === "toolCall") total += estimateTokens(JSON.stringify(b.arguments ?? {}));
	}
	return total;
}

/** Estima tokens de UMA entrada de sessão (heurística — texto, tools, resumos). */
export function estimateEntryTokens(entry: EpisodeEntryLike): number {
	const msg = entry.message;
	let total = 0;
	if (msg) {
		if (msg.content !== undefined) total += estimateContentTokens(msg.content);
		if (typeof msg.command === "string") total += estimateTokens(msg.command);
		if (typeof msg.output === "string") total += estimateTokens(msg.output);
	}
	if (typeof entry.summary === "string") total += estimateTokens(entry.summary);
	if (typeof entry.content === "string") total += estimateTokens(entry.content);
	return total;
}

/** Estima tokens de um trecho do branch (do último user prompt até a folha). */
export function estimateEpisodeTokens(entries: EpisodeEntryLike[]): number {
	return entries.reduce((sum, e) => sum + estimateEntryTokens(e), 0);
}

/**
 * Impressão digital de um episódio: hash dos ids das entradas no range.
 * Determinística e estável por episódio — usada para dedup de agent_settled
 * reemitido e (futuramente) idempotência de jobs.
 */
export function buildEpisodeFingerprint(entryIds: string[]): string {
	return createHash("sha256").update(entryIds.join(",")).digest("hex").slice(0, 16);
}

/** Registro completo de um episódio (linha da tabela episodes). */
export interface EpisodeRecord {
	id: string;
	projectId: string;
	sessionId: string;
	sessionFile: string;
	startEntryId: string;
	endEntryId: string;
	leafId: string;
	fingerprint: string;
	settledAt: string;
	tokenEstimate: number;
	eligibilityScore: number;
	status: EpisodeStatus;
}

/** Dados para inserir um episódio novo (status vira 'pending'). */
export interface NewEpisode {
	projectId: string;
	sessionId: string;
	sessionFile: string;
	startEntryId: string;
	endEntryId: string;
	leafId: string;
	fingerprint: string;
	tokenEstimate: number;
	eligibilityScore?: number;
}

/** Dados para inserir uma evidência (linha da tabela evidence). */
export interface NewEvidence {
	episodeId: string;
	entryId?: string;
	toolCallId?: string;
	kind: string;
	toolName?: string;
	payloadJson: string;
	contentHash: string;
	tokenEstimate: number;
	redactionFlags: number;
	isError: number;
	priority: number;
}

/** Registro completo de uma evidência (linha da tabela evidence). */
export interface EvidenceRecord {
	id: string;
	episodeId: string;
	entryId?: string;
	toolCallId?: string;
	kind: string;
	toolName?: string;
	payloadJson: string;
	contentHash: string;
	tokenEstimate: number;
	redactionFlags: number;
	isError: boolean;
	priority: number;
}

function mapEpisodeRow(row: Record<string, unknown>): EpisodeRecord {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		sessionId: String(row.session_id),
		sessionFile: String(row.session_file),
		startEntryId: String(row.start_entry_id),
		endEntryId: String(row.end_entry_id),
		leafId: String(row.leaf_id),
		fingerprint: String(row.fingerprint),
		settledAt: String(row.settled_at),
		tokenEstimate: Number(row.token_estimate),
		eligibilityScore: Number(row.eligibility_score),
		status: row.status as EpisodeStatus,
	};
}

function mapEvidenceRow(row: Record<string, unknown>): EvidenceRecord {
	return {
		id: String(row.id),
		episodeId: String(row.episode_id),
		entryId: row.entry_id === null ? undefined : String(row.entry_id),
		toolCallId: row.tool_call_id === null ? undefined : String(row.tool_call_id),
		kind: String(row.kind),
		toolName: row.tool_name === null ? undefined : String(row.tool_name),
		payloadJson: String(row.payload_json),
		contentHash: String(row.content_hash),
		tokenEstimate: Number(row.token_estimate),
		redactionFlags: Number(row.redaction_flags),
		isError: Number(row.is_error) === 1,
		priority: Number(row.priority),
	};
}

export class PipelineDB {
	private db: DatabaseLike | null = null;
	private opened = false;
	readonly dbPath: string;

	constructor(dbPath: string = PIPELINE_DB_PATH) {
		this.dbPath = dbPath;
	}

	get isOpen(): boolean {
		return this.opened;
	}

	/** Abre o banco (WAL, busy_timeout, FK) e cria o schema se ausente. */
	open(): void {
		if (this.isOpen) return;
		const db = new DatabaseCtor(this.dbPath);
		try {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("PRAGMA foreign_keys = ON");
			db.exec(SCHEMA_SQL);
			this.db = db;
			this.opened = true;
			this.setMeta("schema_version", String(PIPELINE_SCHEMA_VERSION));
		} catch (err) {
			// Handle aberto não pode vazar — fecha antes de descartar.
			try {
				db.close();
			} catch {
				// close best-effort — estado já degradado
			}
			this.db = null;
			throw err;
		}
		this.restrictDbFiles();
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.opened = false;
	}

	private requireDb(): DatabaseLike {
		if (!this.db) throw new Error("PipelineDB não está aberto — chame open() antes.");
		return this.db;
	}

	private setMeta(key: string, value: string): void {
		this.requireDb()
			.prepare(
				"INSERT INTO pipeline_meta (key, value) VALUES (?, ?) " +
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

	/**
	 * Insere um episódio com status 'pending'. Retorna o id gerado.
	 * Lança em duplicata (índice único session_id+fingerprint) — o chamador
	 * deve checar findEpisodeByFingerprint antes quando o dedup importa.
	 */
	insertEpisode(ep: NewEpisode): string {
		const id = newPipelineId("ep_");
		const now = new Date().toISOString();
		this.requireDb()
			.prepare(
				`INSERT INTO episodes
				   (id, project_id, session_id, session_file, start_entry_id,
				    end_entry_id, leaf_id, fingerprint, settled_at,
				    token_estimate, eligibility_score, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				ep.projectId,
				ep.sessionId,
				ep.sessionFile,
				ep.startEntryId,
				ep.endEntryId,
				ep.leafId,
				ep.fingerprint,
				now,
				ep.tokenEstimate,
				ep.eligibilityScore ?? 0,
				EPISODE_STATUS.PENDING,
			);
		return id;
	}

	/** Busca episódio por (session_id, fingerprint) — dedup de captura. */
	findEpisodeByFingerprint(
		sessionId: string,
		fingerprint: string,
	): EpisodeRecord | undefined {
		const row = this.requireDb()
			.prepare("SELECT * FROM episodes WHERE session_id = ? AND fingerprint = ?")
			.get(sessionId, fingerprint) as Record<string, unknown> | undefined;
		return row ? mapEpisodeRow(row) : undefined;
	}

	/** Conta episódios, opcionalmente filtrado por projeto e/ou status. */
	countEpisodes(projectId?: string, status?: EpisodeStatus): number {
		const clauses: string[] = [];
		const params: string[] = [];
		if (projectId) {
			clauses.push("project_id = ?");
			params.push(projectId);
		}
		if (status) {
			clauses.push("status = ?");
			params.push(status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const row = this.requireDb()
			.prepare(`SELECT COUNT(*) AS n FROM episodes${where}`)
			.get(...params) as { n: number };
		return Number(row.n);
	}

	/** Busca episódio por id. */
	getEpisode(id: string): EpisodeRecord | undefined {
		const row = this.requireDb()
			.prepare("SELECT * FROM episodes WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? mapEpisodeRow(row) : undefined;
	}

	/**
	 * Fecha a normalização de um episódio em transação única: insere as
	 * evidências e marca o status final (normalized | ignored). Falha faz
	 * ROLLBACK — episódio permanece no status anterior (retry seguro).
	 */
	finalizeEpisode(episodeId: string, evidence: NewEvidence[], status: EpisodeStatus): void {
		const db = this.requireDb();
		db.exec("BEGIN");
		try {
			const stmt = db.prepare(
				`INSERT INTO evidence
				   (id, episode_id, entry_id, tool_call_id, kind, tool_name,
				    payload_json, content_hash, token_estimate, redaction_flags,
				    is_error, priority)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const ev of evidence) {
				stmt.run(
					newPipelineId("ev_"),
					ev.episodeId,
					ev.entryId ?? null,
					ev.toolCallId ?? null,
					ev.kind,
					ev.toolName ?? null,
					ev.payloadJson,
					ev.contentHash,
					ev.tokenEstimate,
					ev.redactionFlags,
					ev.isError,
					ev.priority,
				);
			}
			db.prepare("UPDATE episodes SET status = ? WHERE id = ?").run(status, episodeId);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Lista evidências de um episódio (ordem de inserção). */
	listEvidenceByEpisode(episodeId: string): EvidenceRecord[] {
		const rows = this.requireDb()
			.prepare("SELECT * FROM evidence WHERE episode_id = ? ORDER BY rowid")
			.all(episodeId) as Record<string, unknown>[];
		return rows.map(mapEvidenceRow);
	}

	/** Conta evidências, opcionalmente de um episódio específico. */
	countEvidence(episodeId?: string): number {
		const sql =
			episodeId !== undefined
				? "SELECT COUNT(*) AS n FROM evidence WHERE episode_id = ?"
				: "SELECT COUNT(*) AS n FROM evidence";
		const row = this.requireDb().prepare(sql).get(...(episodeId !== undefined ? [episodeId] : [])) as {
			n: number;
		};
		return Number(row.n);
	}
}
