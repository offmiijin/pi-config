/**
 * sqlite-adapter — Interface comum para SQLite entre Bun e Node.
 *
 * Abstrai as diferenças de API entre bun:sqlite e better-sqlite3
 * para que o SqliteStore funcione em ambos os runtimes.
 */

/** Statement preparado com bind params nomeados ($param). */
export interface SqliteStatement {
  run(...params: any[]): { changes: number };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/** Database adapter com API mínima comum. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}
