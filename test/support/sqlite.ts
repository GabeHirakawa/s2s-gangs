import Database from "better-sqlite3";
import type { Db, ExecuteResult, Row, SqlValue } from "../../src/db/db";

const bind = (p: SqlValue[]): SqlValue[] =>
  p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));

/** In-memory SQLite Db for tests. Same SQL runs in production against the injected Database. */
export function makeTestDb(): Db {
  const sqlite = new Database(":memory:");
  return {
    async query(sql: string, params: SqlValue[] = []): Promise<Row[]> {
      return sqlite.prepare(sql).all(...bind(params)) as Row[];
    },
    async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
      const info = sqlite.prepare(sql).run(...bind(params));
      return { changes: info.changes, lastInsertId: Number(info.lastInsertRowid) };
    },
  };
}
