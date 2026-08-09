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
export const PIPELINE_SCHEMA_VERSION = 2;

/** Status de episódio (ciclo: pending → normalized → selected → processed | ignored | failed). */
export const EPISODE_STATUS = {
	PENDING: "pending",
	NORMALIZED: "normalized",
	SELECTED: "selected",
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
  error TEXT,
  next_attempt_at TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, project_id);

CREATE TABLE IF NOT EXISTS job_episodes (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  PRIMARY KEY (job_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_job_episodes_episode ON job_episodes(episode_id);

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

/** Registro completo de um job de extração (linha da tabela jobs). */
export interface JobRecord {
	id: string;
	projectId: string;
	reason: string;
	status: JobStatus;
	attempts: number;
	promptVersion: number | null;
	model: string | null;
	reasoningLevel: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	inputTokens: number;
	outputTokens: number;
	error: string | null;
	nextAttemptAt: string | null;
	details: string | null;
}

/** Dados para inserir um candidato (memória proposta pelo modelo). */
export interface NewCandidate {
	jobId: string;
	action: string;
	context: string;
	type: string | null;
	scope: string | null;
	title: string | null;
	summary: string | null;
	content: string | null;
	confidence: number | null;
	evidenceIds: string[];
	supersedes: string | null;
	status: string;
}

/** Registro completo de um candidato (linha da tabela candidates). */
export interface CandidateRecord {
	id: string;
	jobId: string;
	action: string;
	context: string;
	type: string | null;
	scope: string | null;
	title: string | null;
	summary: string | null;
	content: string | null;
	confidence: number | null;
	evidenceIds: string[];
	supersedes: string | null;
	status: string;
	rejectionReason: string | null;
}

/** Campos atualizáveis de um job (whitelist — sem SQL dinâmico arbitrário). */
export interface JobUpdatePatch {
	status?: JobStatus;
	error?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	inputTokens?: number;
	outputTokens?: number;
	nextAttemptAt?: string | null;
	attempts?: number;
	details?: string | null;
	model?: string | null;
	reasoningLevel?: string | null;
	promptVersion?: number | null;
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

function mapJobRow(row: Record<string, unknown>): JobRecord {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		reason: String(row.reason),
		status: row.status as JobStatus,
		attempts: Number(row.attempts),
		promptVersion: row.prompt_version === null ? null : Number(row.prompt_version),
		model: row.model === null ? null : String(row.model),
		reasoningLevel: row.reasoning_level === null ? null : String(row.reasoning_level),
		createdAt: String(row.created_at),
		startedAt: row.started_at === null ? null : String(row.started_at),
		finishedAt: row.finished_at === null ? null : String(row.finished_at),
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		error: row.error === null ? null : String(row.error),
		nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
		details: row.details === null ? null : String(row.details),
	};
}

function mapCandidateRow(row: Record<string, unknown>): CandidateRecord {
	return {
		id: String(row.id),
		jobId: String(row.job_id),
		action: String(row.action),
		context: String(row.context),
		type: row.type === null ? null : String(row.type),
		scope: row.scope === null ? null : String(row.scope),
		title: row.title === null ? null : String(row.title),
		summary: row.summary === null ? null : String(row.summary),
		content: row.content === null ? null : String(row.content),
		confidence: row.confidence === null ? null : Number(row.confidence),
		evidenceIds: JSON.parse(String(row.evidence_ids)) as string[],
		supersedes: row.supersedes === null ? null : String(row.supersedes),
		status: String(row.status),
		rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason),
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
			// Migração v1 → v2: colunas novas em jobs (bancos criados na Fase 0).
			// CREATE TABLE IF NOT EXISTS não altera tabela existente — colunas
			// ausentes são adicionadas por ALTER (no-op se já presentes).
			const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
			const jobColNames = new Set(jobCols.map((c) => c.name));
			if (!jobColNames.has("next_attempt_at")) {
				db.exec("ALTER TABLE jobs ADD COLUMN next_attempt_at TEXT");
			}
			if (!jobColNames.has("details")) {
				db.exec("ALTER TABLE jobs ADD COLUMN details TEXT");
			}
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

	/* ------------------------------------------------------------ */
	/* Jobs (Fase 2)                                                 */
	/* ------------------------------------------------------------ */

	/** Cria um job de extração com status 'queued'. Retorna o id gerado. */
	createJob(projectId: string, reason: string): string {
		const id = newPipelineId("job_");
		this.requireDb()
			.prepare(
				"INSERT INTO jobs (id, project_id, reason, status, attempts, created_at) " +
					"VALUES (?, ?, ?, ?, 0, ?)",
			)
			.run(id, projectId, reason, JOB_STATUS.QUEUED, new Date().toISOString());
		return id;
	}

	/** Busca job por id. */
	getJob(id: string): JobRecord | undefined {
		const row = this.requireDb()
			.prepare("SELECT * FROM jobs WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? mapJobRow(row) : undefined;
	}

	/**
	 * Próximo job elegível do projeto: queued (mais antigo) primeiro, depois
	 * retries cujo next_attempt_at já venceu (ou é NULL = retry imediato).
	 */
	nextEligibleJob(projectId: string): JobRecord | undefined {
		const now = new Date().toISOString();
		const row = this.requireDb()
			.prepare(
				`SELECT * FROM jobs
				 WHERE project_id = ?
				   AND status IN ('queued', 'retry')
				   AND (status <> 'retry' OR next_attempt_at IS NULL OR next_attempt_at <= ?)
				 ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at ASC
				 LIMIT 1`,
			)
			.get(projectId, now) as Record<string, unknown> | undefined;
		return row ? mapJobRow(row) : undefined;
	}

	/** Atualiza campos de um job (whitelist — patch parcial). */
	updateJob(id: string, patch: JobUpdatePatch): void {
		const sets: string[] = [];
		const params: unknown[] = [];
		const cols: Record<keyof JobUpdatePatch, string> = {
			status: "status",
			error: "error",
			startedAt: "started_at",
			finishedAt: "finished_at",
			inputTokens: "input_tokens",
			outputTokens: "output_tokens",
			nextAttemptAt: "next_attempt_at",
			attempts: "attempts",
			details: "details",
			model: "model",
			reasoningLevel: "reasoning_level",
			promptVersion: "prompt_version",
		};
		for (const [key, col] of Object.entries(cols) as [keyof JobUpdatePatch, string][]) {
			if (patch[key] !== undefined) {
				sets.push(`${col} = ?`);
				params.push(patch[key]);
			}
		}
		if (sets.length === 0) return;
		params.push(id);
		this.requireDb().prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
	}

	/**
	 * Agenda retry de um job: incrementa attempts, marca 'retry' e define o
	 * próximo horário permitido (now + delayMs). started/finished limpos.
	 */
	scheduleRetry(jobId: string, opts: { attempts: number; error?: string; delayMs: number }): void {
		const next = new Date(Date.now() + opts.delayMs).toISOString();
		this.requireDb()
			.prepare(
				"UPDATE jobs SET attempts = ?, status = ?, next_attempt_at = ?, error = ?, " +
					"started_at = NULL, finished_at = NULL WHERE id = ?",
			)
			.run(opts.attempts, JOB_STATUS.RETRY, next, opts.error ?? null, jobId);
	}

	/** Marca o job como dead_letter (falha permanente). */
	markDeadLetter(jobId: string, error?: string): void {
		this.requireDb()
			.prepare("UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
			.run(JOB_STATUS.DEAD_LETTER, new Date().toISOString(), error ?? null, jobId);
	}

	/**
	 * Completa um job em transação única: vincula os episódios ao job
	 * (job_episodes), marca-os com o status terminal (selected para seleção,
	 * processed para extração) e finaliza o job em 'done' com auditoria.
	 */
	completeJobWithEpisodes(
		jobId: string,
		episodeIds: string[],
		episodeStatus: EpisodeStatus,
		details: Record<string, unknown> | null,
	): void {
		const db = this.requireDb();
		db.exec("BEGIN");
		try {
			const link = db.prepare(
				"INSERT OR IGNORE INTO job_episodes (job_id, episode_id) VALUES (?, ?)",
			);
			const claim = db.prepare("UPDATE episodes SET status = ? WHERE id = ?");
			for (const epId of episodeIds) {
				link.run(jobId, epId);
				claim.run(episodeStatus, epId);
			}
			db.prepare(
				"UPDATE jobs SET status = ?, finished_at = ?, details = ?, error = NULL WHERE id = ?",
			).run(JOB_STATUS.DONE, new Date().toISOString(), details ? JSON.stringify(details) : null, jobId);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Alias Fase 2: completa job de seleção (episódios → selected). */
	completeJobWithSelection(
		jobId: string,
		episodeIds: string[],
		details: Record<string, unknown> | null,
	): void {
		this.completeJobWithEpisodes(jobId, episodeIds, EPISODE_STATUS.SELECTED, details);
	}

	/** Menor next_attempt_at entre retries pendentes do projeto (ms) ou null. */
	nextRetryDelayMs(projectId: string): number | null {
		const row = this.requireDb()
			.prepare(
				"SELECT MIN(next_attempt_at) AS m FROM jobs WHERE project_id = ? " +
					"AND status = ? AND next_attempt_at IS NOT NULL",
			)
			.get(projectId, JOB_STATUS.RETRY) as { m: string | null };
		if (row.m === null) return null;
		return Math.max(0, new Date(row.m).getTime() - Date.now());
	}

	/** Há job não terminal para o projeto? (evita empilhar jobs). */
	hasActiveJob(projectId: string): boolean {
		const row = this.requireDb()
			.prepare(
				"SELECT 1 FROM jobs WHERE project_id = ? AND status NOT IN ('done','dead_letter') LIMIT 1",
			)
			.get(projectId) as { 1?: number } | undefined;
		return row !== undefined;
	}

	/** Agregação de episódios pendentes de extração (normalized + selected). */
	aggregatePendingEpisodes(projectId: string): { tokens: number; count: number } {
		const row = this.requireDb()
			.prepare(
				"SELECT COALESCE(SUM(token_estimate), 0) AS tokens, COUNT(*) AS n " +
					"FROM episodes WHERE project_id = ? AND status IN (?, ?)",
			)
			.get(projectId, EPISODE_STATUS.NORMALIZED, EPISODE_STATUS.SELECTED) as {
			tokens: number;
			n: number;
		};
		return { tokens: Number(row.tokens), count: Number(row.n) };
	}

	/**
	 * Só episódios NORMALIZED (trabalho novo). Episódios 'selected' já foram
	 * reivindicados por um job — contá-los no gatilho automático criaria loop
	 * (job com pendings deixa episódios selected → gatilho dispara de novo).
	 * Usado por maybeCreateJob; status/métricas continuam via
	 * aggregatePendingEpisodes.
	 */
	aggregateNormalizedEpisodes(projectId: string): { tokens: number; count: number } {
		const row = this.requireDb()
			.prepare(
				"SELECT COALESCE(SUM(token_estimate), 0) AS tokens, COUNT(*) AS n " +
					"FROM episodes WHERE project_id = ? AND status = ?",
			)
			.get(projectId, EPISODE_STATUS.NORMALIZED) as {
			tokens: number;
			n: number;
		};
		return { tokens: Number(row.tokens), count: Number(row.n) };
	}

	/** Lista episódios por status do projeto (mais antigos primeiro). */
	listEpisodesByStatus(projectId: string, status: EpisodeStatus, limit = 200): EpisodeRecord[] {
		return this.listEpisodesByStatuses(projectId, [status], limit);
	}

	/** Lista episódios por múltiplos status do projeto (mais antigos primeiro). */
	listEpisodesByStatuses(
		projectId: string,
		statuses: EpisodeStatus[],
		limit = 200,
	): EpisodeRecord[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(", ");
		const rows = this.requireDb()
			.prepare(
				`SELECT * FROM episodes WHERE project_id = ? AND status IN (${placeholders}) ` +
					"ORDER BY settled_at ASC LIMIT ?",
			)
			.all(projectId, ...statuses, limit) as Record<string, unknown>[];
		return rows.map(mapEpisodeRow);
	}

	/** Episódio com sinal forte (correção do usuário ou comando com erro)? */
	hasStrongSignal(episodeId: string): boolean {
		const row = this.requireDb()
			.prepare(
				"SELECT 1 FROM evidence WHERE episode_id = ? AND " +
					"(kind = ? OR (kind = ? AND is_error = 1)) LIMIT 1",
			)
			.get(episodeId, "correction", "command") as { 1?: number } | undefined;
		return row !== undefined;
	}

	/** Jobs presos em status não terminais (crash/reload) voltam para queued. */
	recoverStuckJobs(): number {
		const result = this.requireDb()
			.prepare(
				"UPDATE jobs SET status = ?, started_at = NULL, finished_at = NULL, " +
					"error = 'recovered from interrupted session' " +
					"WHERE status IN ('processing', 'validating', 'committing')",
			)
			.run(JOB_STATUS.QUEUED);
		return Number(result.changes);
	}

	/**
	 * Jobs 'done' com candidatos pending (estado órfão de versões anteriores /
	 * shutdown no meio do revisor) voltam para queued: o worker re-seleciona os
	 * episódios (includeClaimed) e refaz a extração até resolver. Chamado no
	 * session_start junto com recoverStuckJobs.
	 */
	recoverJobsWithPendingCandidates(): number {
		const db = this.requireDb();
		const rows = db
			.prepare(
				"SELECT DISTINCT j.id FROM jobs j JOIN candidates c ON c.job_id = j.id " +
					"WHERE c.status = ? AND j.status = ?",
			)
			.all(CANDIDATE_STATUS.PENDING, JOB_STATUS.DONE) as { id: string }[];
		if (rows.length === 0) return 0;
		const stmt = db.prepare(
			"UPDATE jobs SET status = ?, started_at = NULL, finished_at = NULL, " +
				"error = 'recovered: candidatos pending' WHERE id = ?",
		);
		for (const row of rows) stmt.run(JOB_STATUS.QUEUED, row.id);
		return rows.length;
	}

	/**
	 * Insere candidatos de um job em transação única. Idempotente: candidatos
	 * anteriores do MESMO job são removidos antes (retry de job não duplica).
	 * A remoção acontece mesmo com lista vazia — retry com resposta sem
	 * memórias não pode deixar candidatos da tentativa anterior pendurados.
	 * Retorna o número inserido.
	 */
	insertCandidates(jobId: string, candidates: NewCandidate[]): number {
		const db = this.requireDb();
		db.exec("BEGIN");
		try {
			db.prepare("DELETE FROM candidates WHERE job_id = ?").run(jobId);
			const stmt = db.prepare(
				`INSERT INTO candidates
				   (id, job_id, action, context, type, scope, title, summary, content,
				    confidence, evidence_ids, supersedes, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const c of candidates) {
				stmt.run(
					newPipelineId("cand_"),
					c.jobId,
					c.action,
					c.context,
					c.type,
					c.scope,
					c.title,
					c.summary,
					c.content,
					c.confidence,
					JSON.stringify(c.evidenceIds),
					c.supersedes,
					c.status,
				);
			}
			db.exec("COMMIT");
			return candidates.length;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Lista candidatos de um job (ordem de inserção). */
	listCandidatesByJob(jobId: string): CandidateRecord[] {
		const rows = this.requireDb()
			.prepare("SELECT * FROM candidates WHERE job_id = ? ORDER BY rowid")
			.all(jobId) as Record<string, unknown>[];
		return rows.map(mapCandidateRow);
	}

	/** Conta candidatos, opcionalmente por job e/ou status. */
	countCandidates(jobId?: string, status?: string): number {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (jobId) {
			clauses.push("job_id = ?");
			params.push(jobId);
		}
		if (status) {
			clauses.push("status = ?");
			params.push(status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const row = this.requireDb()
			.prepare(`SELECT COUNT(*) AS n FROM candidates${where}`)
			.get(...params) as { n: number };
		return Number(row.n);
	}

	/** Atualiza status (e motivo de rejeição) de um candidato. */
	updateCandidateStatus(id: string, status: string, rejectionReason?: string | null): void {
		this.requireDb()
			.prepare("UPDATE candidates SET status = ?, rejection_reason = ? WHERE id = ?")
			.run(status, rejectionReason ?? null, id);
	}

	/** Conta candidatos por status dentro dos jobs de um projeto. */
	countCandidatesByProject(projectId: string, status?: string): number {
		const sql =
			status !== undefined
				? "SELECT COUNT(*) AS n FROM candidates c JOIN jobs j ON c.job_id = j.id " +
					"WHERE j.project_id = ? AND c.status = ?"
				: "SELECT COUNT(*) AS n FROM candidates c JOIN jobs j ON c.job_id = j.id " +
					"WHERE j.project_id = ?";
		const row = this.requireDb()
			.prepare(sql)
			.get(...(status !== undefined ? [projectId, status] : [projectId])) as { n: number };
		return Number(row.n);
	}

	/** Conta jobs, opcionalmente filtrado por projeto e/ou status. */
	countJobs(projectId?: string, status?: JobStatus): number {
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
			.prepare(`SELECT COUNT(*) AS n FROM jobs${where}`)
			.get(...params) as { n: number };
		return Number(row.n);
	}

	/** Lista jobs de um projeto (opcional por status, limitados). */
	listJobs(projectId?: string, status?: JobStatus, limit = 50): JobRecord[] {
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
		const rows = this.requireDb()
			.prepare(`SELECT * FROM jobs${where} ORDER BY created_at DESC LIMIT ?`)
			.all(...params, limit) as Record<string, unknown>[];
		return rows.map(mapJobRow);
	}
}
