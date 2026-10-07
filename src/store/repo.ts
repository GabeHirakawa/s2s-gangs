import type { Db, Row, SqlValue } from "./db";
import type { Gang, GangPlayer, GangRank } from "../domain/types";
import {
  type CachedStat, type StatDescriptor, type StatScope, type StatValue,
  NATIVE_GANG_STATS, NATIVE_PLAYER_STATS, columnsOf, decodeValue, encodeValue, fromColumn,
  isRecord, nativeDescriptor,
} from "./stats";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Table prefixes, stat ids and column names are interpolated into SQL (never parameterizable). */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid sql identifier: ${name}`);
  return name;
}

export interface StatRow { owner: string; statId: string; value: CachedStat; }
export interface Snapshot {
  gangs: Gang[];
  ranks: Array<{ gangId: number; rank: GangRank }>;
  /** Every player that belongs to a gang. */
  members: GangPlayer[];
  /** owner = decimal gang id. */
  gangStats: StatRow[];
  /** owner = steam; only rows of gang members. */
  memberStats: StatRow[];
}
export interface PlayerSnapshot { player: GangPlayer | null; stats: StatRow[]; }

const toGang = (r: Row): Gang => ({ gangId: Number(r.GangId), name: String(r.Name) });
const toRank = (r: Row): GangRank => ({ rank: Number(r.Rank), name: String(r.Name), permissions: Number(r.Permissions) });
const toPlayer = (r: Row): GangPlayer => ({
  steam: String(r.Steam),
  name: r.Name === null ? null : String(r.Name),
  gangId: r.GangId === null ? null : Number(r.GangId),
  gangRank: r.GangRank === null ? null : Number(r.GangRank),
});
const PLAYER_COLS = "CAST(Steam AS TEXT) AS Steam, Name, GangId, GangRank";

/**
 * The whole SQL surface. Table layout is upstream-compatible:
 * `<p>_gangs`, `<p>_players`, `<p>_ranks`, one instance table per native stat
 * (`<p>_gang_stats_<id>` / `<p>_player_stats_<id>`), plus one key/value table per scope
 * (`<p>_gang_stat_values` / `<p>_player_stat_values`) for every other stat id (e.g. `perk:<id>`),
 * whose values are stored as JSON text.
 */
export class GangsRepo {
  private readonly p: string;
  constructor(private readonly db: Db, prefix: string) { this.p = ident(prefix); }

  private get gangs(): string { return `${this.p}_gangs`; }
  private get players(): string { return `${this.p}_players`; }
  private get ranks(): string { return `${this.p}_ranks`; }
  private statTable(scope: StatScope, statId: string): string { return `${this.p}_${scope}_stats_${ident(statId)}`; }
  private kvTable(scope: StatScope): string { return `${this.p}_${scope}_stat_values`; }
  private pk(scope: StatScope): string { return scope === "gang" ? "GangId" : "Steam"; }

  async ensureTables(): Promise<void> {
    const db = this.db;
    await db.execute(`CREATE TABLE IF NOT EXISTS ${this.gangs} (GangId INTEGER PRIMARY KEY, Name VARCHAR(255) NOT NULL)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS ${this.players} (Steam BIGINT PRIMARY KEY, Name VARCHAR(255), GangId INT, GangRank INT)`);
    await db.execute(
      `CREATE TABLE IF NOT EXISTS ${this.ranks} (GangId INT NOT NULL, ` +
      "`Rank` INT NOT NULL, Name VARCHAR(255) NOT NULL, Permissions INT NOT NULL, PRIMARY KEY (GangId, `Rank`))",
    );
    for (const d of [...NATIVE_GANG_STATS, ...NATIVE_PLAYER_STATS]) {
      const cols = columnsOf(d).map(([n, t]) => `${ident(n)} ${t}`).join(", ");
      const pkType = d.scope === "gang" ? "INTEGER" : "BIGINT";
      await db.execute(
        `CREATE TABLE IF NOT EXISTS ${this.statTable(d.scope, d.id)} (${this.pk(d.scope)} ${pkType} NOT NULL PRIMARY KEY, ${cols})`,
      );
    }
    await db.execute(
      `CREATE TABLE IF NOT EXISTS ${this.kvTable("gang")} (GangId INTEGER NOT NULL, StatId VARCHAR(255) NOT NULL, ` +
      "Value TEXT, PRIMARY KEY (GangId, StatId))",
    );
    await db.execute(
      `CREATE TABLE IF NOT EXISTS ${this.kvTable("player")} (Steam BIGINT NOT NULL, StatId VARCHAR(255) NOT NULL, ` +
      "Value TEXT, PRIMARY KEY (Steam, StatId))",
    );
  }

  // ── loads ─────────────────────────────────────────────────────────────────────────────────────
  private async loadStats(scope: StatScope, where: string, params: SqlValue[]): Promise<StatRow[]> {
    const out: StatRow[] = [];
    const key = scope === "gang" ? "GangId" : "CAST(Steam AS TEXT)";
    for (const d of scope === "gang" ? NATIVE_GANG_STATS : NATIVE_PLAYER_STATS) {
      const cols = columnsOf(d);
      const rows = await this.db.query(
        `SELECT ${key} AS K, ${cols.map(([n]) => n).join(", ")} FROM ${this.statTable(scope, d.id)} ${where}`, params,
      );
      for (const r of rows) out.push({ owner: String(r.K), statId: d.id, value: readNative(d, r) });
    }
    const kv = await this.db.query(`SELECT ${key} AS K, StatId, Value FROM ${this.kvTable(scope)} ${where}`, params);
    for (const r of kv) out.push({ owner: String(r.K), statId: String(r.StatId), value: decodeValue(r.Value) });
    return out;
  }

  async loadAll(): Promise<Snapshot> {
    const gangs = (await this.db.query(`SELECT GangId, Name FROM ${this.gangs}`)).map(toGang);
    const ranks = (await this.db.query("SELECT GangId, `Rank`, Name, Permissions FROM " + this.ranks))
      .map((r) => ({ gangId: Number(r.GangId), rank: toRank(r) }));
    const members = (await this.db.query(`SELECT ${PLAYER_COLS} FROM ${this.players} WHERE GangId IS NOT NULL`)).map(toPlayer);
    const gangStats = await this.loadStats("gang", "", []);
    const memberStats = await this.loadStats(
      "player", `WHERE Steam IN (SELECT Steam FROM ${this.players} WHERE GangId IS NOT NULL)`, [],
    );
    return { gangs, ranks, members, gangStats, memberStats };
  }

  /** One player's row (inserted if missing, with `name`) and their stats. */
  async loadPlayer(steam: string, name: string | null): Promise<PlayerSnapshot> {
    const rows = await this.db.query(`SELECT ${PLAYER_COLS} FROM ${this.players} WHERE Steam = ?`, [steam]);
    let player = rows.length ? toPlayer(rows[0]) : null;
    if (!player) {
      await this.db.execute(`INSERT INTO ${this.players} (Steam, Name) VALUES (?, ?)`, [steam, name]);
      player = { steam, name, gangId: null, gangRank: null };
    }
    const stats = await this.loadStats("player", "WHERE Steam = ?", [steam]);
    return { player, stats };
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────
  async insertGang(gang: Gang): Promise<void> {
    await this.db.execute(`INSERT INTO ${this.gangs} (GangId, Name) VALUES (?, ?)`, [gang.gangId, gang.name]);
  }
  async renameGang(gangId: number, name: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.gangs} SET Name = ? WHERE GangId = ?`, [name, gangId]);
  }
  /** Remove a gang, its ranks, its stats, and every membership pointing at it. */
  async deleteGang(gangId: number): Promise<void> {
    await this.db.execute(`UPDATE ${this.players} SET GangId = NULL, GangRank = NULL WHERE GangId = ?`, [gangId]);
    await this.db.execute(`DELETE FROM ${this.ranks} WHERE GangId = ?`, [gangId]);
    for (const d of NATIVE_GANG_STATS)
      await this.db.execute(`DELETE FROM ${this.statTable("gang", d.id)} WHERE GangId = ?`, [gangId]);
    await this.db.execute(`DELETE FROM ${this.kvTable("gang")} WHERE GangId = ?`, [gangId]);
    await this.db.execute(`DELETE FROM ${this.gangs} WHERE GangId = ?`, [gangId]);
  }

  async upsertPlayer(p: GangPlayer): Promise<void> {
    const res = await this.db.execute(
      `UPDATE ${this.players} SET Name = ?, GangId = ?, GangRank = ? WHERE Steam = ?`,
      [p.name, p.gangId, p.gangRank, p.steam],
    );
    if (res.changes === 0) {
      await this.db.execute(
        `INSERT INTO ${this.players} (Steam, Name, GangId, GangRank) VALUES (?, ?, ?, ?)`,
        [p.steam, p.name, p.gangId, p.gangRank],
      );
    }
  }

  async insertRank(gangId: number, r: GangRank): Promise<void> {
    await this.db.execute(
      "INSERT INTO " + this.ranks + " (GangId, `Rank`, Name, Permissions) VALUES (?, ?, ?, ?)",
      [gangId, r.rank, r.name, r.permissions],
    );
  }
  async updateRank(gangId: number, r: GangRank): Promise<void> {
    await this.db.execute(
      "UPDATE " + this.ranks + " SET Name = ?, Permissions = ? WHERE GangId = ? AND `Rank` = ?",
      [r.name, r.permissions, gangId, r.rank],
    );
  }
  async deleteRank(gangId: number, rank: number): Promise<void> {
    await this.db.execute("DELETE FROM " + this.ranks + " WHERE GangId = ? AND `Rank` = ?", [gangId, rank]);
  }

  /** Persist one stat value; `null` deletes the row. Native ids go to their instance table. */
  async writeStat(scope: StatScope, owner: string | number, statId: string, value: CachedStat): Promise<void> {
    const pk = this.pk(scope);
    const d = nativeDescriptor(scope, statId);
    if (!d) {
      const t = this.kvTable(scope);
      if (value === null) {
        await this.db.execute(`DELETE FROM ${t} WHERE ${pk} = ? AND StatId = ?`, [owner, statId]);
        return;
      }
      if (isRecord(value)) throw new Error(`record value for non-native stat ${statId}`);
      await this.db.execute(
        `INSERT INTO ${t} (${pk}, StatId, Value) VALUES (?, ?, ?) ON CONFLICT(${pk}, StatId) DO UPDATE SET Value = excluded.Value`,
        [owner, statId, encodeValue(value)],
      );
      return;
    }
    const t = this.statTable(scope, d.id);
    if (value === null) {
      await this.db.execute(`DELETE FROM ${t} WHERE ${pk} = ?`, [owner]);
      return;
    }
    const names = columnsOf(d).map(([n]) => n);
    const values: SqlValue[] = d.kind === "scalar"
      ? [isRecord(value) ? null : value]
      : names.map((n) => (isRecord(value) ? value[n] ?? null : null));
    await this.db.execute(
      `INSERT INTO ${t} (${pk}, ${names.join(", ")}) VALUES (?, ${names.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(${pk}) DO UPDATE SET ${names.map((n) => `${n} = excluded.${n}`).join(", ")}`,
      [owner, ...values],
    );
  }
}

function readNative(d: StatDescriptor, r: Row): CachedStat {
  if (d.kind === "scalar") return fromColumn(d.column, r[d.id] ?? null);
  const rec: Record<string, SqlValue> = {};
  for (const [n] of columnsOf(d)) rec[n] = r[n] ?? null;
  return rec;
}

export type { StatValue };
