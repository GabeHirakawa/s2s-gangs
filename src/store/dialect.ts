/**
 * SQL dialect differences, in one place. Everything else in the store is dialect-neutral SQL built
 * through these helpers.
 *
 * - Identifiers are ALWAYS quoted: MySQL needs it for reserved words (`Rank`), and Postgres folds
 *   unquoted names to lowercase, which would change the column keys of result rows.
 * - Placeholders stay `?` (the s2script host rewrites them to `$n` for Postgres). Postgres binds
 *   parameters strictly typed (strings as text, numbers as int8, null as text), so every parameter
 *   is wrapped in `CAST(? AS <column type>)` there; SQLite and MySQL coerce implicitly.
 * - Upserts: SQLite/Postgres `ON CONFLICT (...) DO UPDATE SET c = excluded.c`; MySQL
 *   `ON DUPLICATE KEY UPDATE c = VALUES(c)`.
 */
export type DialectName = "sqlite" | "mysql" | "postgres";
export const DIALECTS: readonly DialectName[] = ["sqlite", "mysql", "postgres"];

export function parseDialect(raw: string): DialectName | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return "sqlite";
  if (v === "postgresql" || v === "pg") return "postgres";
  if (v === "mariadb") return "mysql";
  return (DIALECTS as readonly string[]).includes(v) ? (v as DialectName) : null;
}

/** A column in a generated statement: its name and SQL type (for Postgres parameter casts). */
export interface Col { name: string; type: string; }

export class Dialect {
  constructor(readonly name: DialectName) {}

  /** Quote an identifier (`a`.`b`-style dotted names are not used by the store). */
  q(ident: string): string {
    return this.name === "postgres" ? `"${ident.replace(/"/g, '""')}"` : "`" + ident.replace(/`/g, "``") + "`";
  }

  /** A bound parameter for a column of `type`. */
  param(type: string): string {
    if (this.name !== "postgres") return "?";
    // int8 → boolean has no direct cast in Postgres; go through integer.
    if (type.toUpperCase() === "BOOLEAN") return "CAST(CAST(? AS INTEGER) AS BOOLEAN)";
    return `CAST(? AS ${type})`;
  }

  /** `expr` as a string (used to read 64-bit SteamIDs without float precision loss). */
  castText(expr: string): string {
    return `CAST(${expr} AS ${this.name === "mysql" ? "CHAR" : "TEXT"})`;
  }

  /** INSERT … or update every non-key column when the key already exists. */
  upsert(table: string, keys: Col[], values: Col[]): string {
    const all = [...keys, ...values];
    const head =
      `INSERT INTO ${this.q(table)} (${all.map((c) => this.q(c.name)).join(", ")}) ` +
      `VALUES (${all.map((c) => this.param(c.type)).join(", ")})`;
    if (this.name === "mysql") {
      // A key-only table still needs a no-op assignment for ON DUPLICATE KEY.
      const sets = (values.length ? values : keys.slice(0, 1))
        .map((c) => `${this.q(c.name)} = VALUES(${this.q(c.name)})`).join(", ");
      return `${head} ON DUPLICATE KEY UPDATE ${sets}`;
    }
    const conflict = `ON CONFLICT (${keys.map((c) => this.q(c.name)).join(", ")})`;
    if (!values.length) return `${head} ${conflict} DO NOTHING`;
    const ex = this.name === "postgres" ? "EXCLUDED" : "excluded";
    return `${head} ${conflict} DO UPDATE SET ${values.map((c) => `${this.q(c.name)} = ${ex}.${this.q(c.name)}`).join(", ")}`;
  }

  /** CREATE TABLE IF NOT EXISTS with a (possibly composite) primary key. No autoincrement anywhere:
   *  Gangs assigns every id itself. Types used (INTEGER, INT, BIGINT, VARCHAR(255), TEXT, REAL,
   *  BOOLEAN) are valid on all three; no TEXT column is part of a key (MySQL forbids that). */
  createTable(table: string, cols: Array<Col & { notNull?: boolean }>, primaryKey: string[]): string {
    const defs = cols.map((c) => `${this.q(c.name)} ${c.type}${c.notNull || primaryKey.includes(c.name) ? " NOT NULL" : ""}`);
    defs.push(`PRIMARY KEY (${primaryKey.map((k) => this.q(k)).join(", ")})`);
    return `CREATE TABLE IF NOT EXISTS ${this.q(table)} (${defs.join(", ")})`;
  }
}
