/**
 * Declaração mínima do driver bun:sqlite para o typecheck em runtime Node.
 * O módulo só existe sob Bun — aqui tipamos a superfície usada pelo db.ts
 * (a construção real é via import dinâmico em runtime).
 */
declare module "bun:sqlite" {
	export class Database {
		constructor(path: string);
		prepare(sql: string): {
			get(...params: unknown[]): Record<string, unknown> | null | undefined;
			all(...params: unknown[]): Record<string, unknown>[];
			run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
		};
		exec(sql: string): unknown;
		close(): void;
	}
}
