/**
 * pi-memory — Driver SQLite compartilhado (node:sqlite sob Node, bun:sqlite sob Bun).
 *
 * O driver é resolvido em runtime: a extensão roda in-process no pi, que é
 * distribuído como binário Bun (ELF compilado) e como pacote npm (Node). O
 * acesso ao banco fica isolado aqui — os bancos (.index.sqlite e
 * .pipeline.sqlite) usam a mesma superfície (prepare/run/get/all/exec/close).
 */

/** Superfície mínima de statement usada pelos bancos (comum aos dois drivers). */
export interface StatementLike {
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
	run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** Superfície mínima de conexão usada pelos bancos (comum aos dois drivers). */
export interface DatabaseLike {
	exec(sql: string): unknown;
	prepare(sql: string): StatementLike;
	close(): void;
}

export type DatabaseCtor = new (path: string) => DatabaseLike;

/**
 * Resolve o construtor de banco por runtime.
 * - Node → `node:sqlite` (DatabaseSync) — suíte de testes roda aqui.
 * - Bun → `bun:sqlite` (Database) — pi binário roda aqui; Bun não tem node:sqlite.
 * Falha nos dois ⇒ erro claro em vez de módulo quebrado.
 */
export async function resolveDatabaseCtor(): Promise<DatabaseCtor> {
	try {
		const mod = await import("node:sqlite");
		return mod.DatabaseSync as unknown as DatabaseCtor;
	} catch {
		const mod = await import("bun:sqlite");
		return mod.Database as unknown as DatabaseCtor;
	}
}

export const DatabaseCtor = await resolveDatabaseCtor();
