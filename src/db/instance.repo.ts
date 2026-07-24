import type { Db, Row, SqlValue } from "./db";

export type ColumnType = "INT" | "BIGINT" | "VARCHAR(255)" | "REAL" | "BOOLEAN";
export type StatScope = "gang" | "player";
export interface ScalarStat { id: string; scope: StatScope; kind: "scalar"; column: ColumnType; }
export interface RecordStat { id: string; scope: StatScope; kind: "record"; columns: Record<string, ColumnType>; }
export type StatDescriptor = ScalarStat | RecordStat;

const cols = (d: StatDescriptor): Array<[string, ColumnType]> =>
  d.kind === "scalar" ? [[d.id, d.column]] : Object.entries(d.columns);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** stat ids and column names are interpolated into SQL and register() is reachable across the API
 *  boundary, so identifiers are validated (never parameterizable in SQL). */
function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid sql identifier: ${name}`);
  return name;
}

export class StatStore {
  private ensured = new Set<string>();
  constructor(private db: Db, private tablePrefix: string, private pk: string, private pkType: string) {}

  private table(statId: string): string { return `${this.tablePrefix}_${assertIdent(statId)}`; }

  private async ensure(d: StatDescriptor): Promise<void> {
    if (this.ensured.has(d.id)) return;
    for (const [n] of cols(d)) assertIdent(n);
    const colDefs = cols(d).map(([n, t]) => `${n} ${t}`).join(", ");
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${this.table(d.id)} (${this.pk} ${this.pkType} NOT NULL PRIMARY KEY, ${colDefs})`
    );
    this.ensured.add(d.id);
  }

  async get<T>(d: StatDescriptor, key: string | number): Promise<T | null> {
    await this.ensure(d);
    const names = cols(d).map(([n]) => n);
    const rows = await this.db.query(
      `SELECT ${names.join(", ")} FROM ${this.table(d.id)} WHERE ${this.pk} = ?`, [key]
    );
    if (!rows.length) return null;
    if (d.kind === "scalar") return rows[0][d.id] as unknown as T;
    return rows[0] as unknown as T;
  }

  async set<T>(d: StatDescriptor, key: string | number, value: T): Promise<boolean> {
    await this.ensure(d);
    const entries = cols(d).map(([n]) => n);
    const values: SqlValue[] =
      d.kind === "scalar" ? [value as unknown as SqlValue]
                          : entries.map((n) => (value as Record<string, SqlValue>)[n]);
    const placeholders = entries.map(() => "?").join(", ");
    const updates = entries.map((n) => `${n} = excluded.${n}`).join(", ");
    await this.db.execute(
      `INSERT INTO ${this.table(d.id)} (${this.pk}, ${entries.join(", ")}) ` +
      `VALUES (?, ${placeholders}) ON CONFLICT(${this.pk}) DO UPDATE SET ${updates}`,
      [key, ...values]
    );
    return true;
  }

  async remove(statId: string, key: string | number): Promise<boolean> {
    try {
      const res = await this.db.execute(
        `DELETE FROM ${this.table(statId)} WHERE ${this.pk} = ?`, [key]
      );
      return res.changes > 0;
    } catch (e) {
      if (String(e).includes("no such table")) return false;
      throw e;
    }
  }
}
