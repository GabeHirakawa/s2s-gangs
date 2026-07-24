/** Local mirror of @s2script/sdk/db's surface so repos are testable off-runtime.
 *  The real Database (query/execute) satisfies this structurally in production. */
export type SqlValue = string | number | boolean | null;
export type Row = Record<string, SqlValue>;
export interface ExecuteResult { changes: number; lastInsertId: number; }
export interface Db {
  query(sql: string, params?: SqlValue[]): Promise<Row[]>;
  execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult>;
}
