/**
 * pi-memory — Driver SQLite compartilhado (node:sqlite sob Node, bun:sqlite sob Bun).
 *
 * O driver é resolvido em runtime: a extensão roda in-process no pi, que é
 * distribuído como binário Bun (ELF compilado) e como pacote npm (Node). O
 * acesso ao banco fica isolado aqui — os bancos (.index.sqlite e
 * .pipeline.sqlite) usam a mesma superfície (prepare/run/get/all/exec/close).
 *
 * Normaliza divergência bun:sqlite × node:sqlite: bun:sqlite retorna null
 * para .get() sem match enquanto node:sqlite retorna undefined. O wrapper
 * garante que .get() sempre retorna undefined quando não há linha — código
 * de produção nunca vê null.
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
 * Resolve o construtor de banco por runtime e aplica wrapper para
 * normalizar bun:sqlite .get() que retorna null em vez de undefined.
 */
async function resolveDatabaseCtor(): Promise<DatabaseCtor> {
	try {
		const mod = await import("node:sqlite");
		return mod.DatabaseSync as unknown as DatabaseCtor;
	} catch {
		// Bun — precisa de wrapper para normalizar null → undefined
		const mod = await import("bun:sqlite");
		const BunDatabase = mod.Database as unknown as DatabaseCtor;

		return class extends BunDatabase {
			prepare(sql: string): StatementLike {
				const stmt = super.prepare(sql);
				return {
					get(...params: unknown[]): Record<string, unknown> | undefined {
						return (stmt.get as (...p: unknown[]) => Record<string, unknown> | null | undefined)(...params) ?? undefined;
					},
					all(...params: unknown[]): Record<string, unknown>[] {
						return (stmt.all as (...p: unknown[]) => Record<string, unknown>[])(...params);
					},
					run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
						return (stmt.run as (...p: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(...params);
					},
				};
			}
		};
	}
}

export const DatabaseCtor = await resolveDatabaseCtor();
