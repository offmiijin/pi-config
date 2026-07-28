/**
 * sqlite-factory — Cria SqliteDatabase adaptado ao runtime (Bun ou Node).
 *
 * Detecta o runtime e retorna o adapter apropriado:
 *   - Bun:   bun:sqlite (nativo, zero deps)
 *   - Node:  better-sqlite3 (npm install better-sqlite3)
 *
 * Usa createRequire para carga síncrona — necessário porque
 * o construtor do SqliteStore é síncrono.
 */

import { createRequire } from "node:module";
import type { SqliteDatabase, SqliteStatement } from "./sqlite-adapter";

// ── Helpers ──────────────────────────────────────────────────────────

function isBun(): boolean {
  return typeof (globalThis as any).Bun !== "undefined";
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSqliteDb(path: string): SqliteDatabase {
  const req = createRequire(import.meta.url);

  if (isBun()) {
    return createBunDb(req, path);
  }
  return createNodeDb(req, path);
}

// ── Bun adapter (inline) ─────────────────────────────────────────────

function createBunDb(req: NodeRequire, path: string): SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Database: any;
  try {
    Database = req("bun:sqlite").Database;
  } catch {
    throw new Error(
      "pi-memory: bun:sqlite não disponível. Verifique a instalação do Bun."
    );
  }

  const db = new Database(path, { create: true });

  return {
    prepare(sql: string): SqliteStatement {
      const stmt = db.query(sql);
      return {
        run: (...params: any[]) => stmt.run(...params),
        get: (...params: any[]) => stmt.get(...params),
        all: (...params: any[]) => stmt.all(...params),
      };
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    close(): void {
      db.close();
    },
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      return db.transaction(fn) as T;
    },
  };
}

// ── Node adapter (inline) ────────────────────────────────────────────

/**
 * Traduz $param → @param no SQL.
 * better-sqlite3 suporta @param e :param, mas não $param (que o Bun usa).
 */
function translateSql(sql: string): string {
  return sql.replace(/\$(\w+)/g, "@$1");
}

/**
 * Traduz chaves $param → param (sem prefixo) nos objetos de bind.
 * better-sqlite3 usa chaves sem prefixo no JS, independente do
 * prefixo usado no SQL ($param, @param, :param).
 * Ex: { $id: 1 } → { id: 1 } para SQL "VALUES (@id)".
 */
function translateParams(params: any[]): any[] {
  return params.map((p) => {
    if (typeof p === "object" && p !== null && !Array.isArray(p)) {
      const translated: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(p as Record<string, unknown>)) {
        // Remove prefix $, @, : dos nomes (better-sqlite3 usa chave sem prefixo)
        const cleanKey = key.replace(/^[$@:]/, "");
        translated[cleanKey] = value;
      }
      return translated;
    }
    return p;
  });
}

function createNodeDb(req: NodeRequire, path: string): SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BetterSqlite3: any;
  try {
    BetterSqlite3 = req("better-sqlite3");
  } catch {
    throw new Error(
      "pi-memory requer `better-sqlite3` para Node.js.\n" +
      "Instale: npm install better-sqlite3"
    );
  }

  const db = new BetterSqlite3(path);

  return {
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(translateSql(sql));
      return {
        run: (...params: any[]) => {
          const result = stmt.run(...translateParams(params));
          return { changes: result.changes };
        },
        get: (...params: any[]) => stmt.get(...translateParams(params)),
        all: (...params: any[]) => stmt.all(...translateParams(params)),
      };
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    close(): void {
      db.close();
    },
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      return db.transaction(fn) as T;
    },
  };
}
