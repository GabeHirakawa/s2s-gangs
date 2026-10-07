import type { Db, Row, SqlValue } from "./db";
import { Dialect, type Col, type DialectName } from "./dialect";
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

const GANG_ID: Col = { name: "GangId", type: "INTEGER" };
const STEAM: Col = { name: "Steam", type: "BIGINT" };
const NAME: Col = { name: "Name", type: "VARCHAR(255)" };
const RANK: Col = { name: "Rank", type: "INT" };
const PERMS: Col = { name: "Permissions", type: "INT" };
const STAT_ID: Col = { name: "StatId", type: "VARCHAR(255)" };
const VALUE: Col = { name: "Value", type: "TEXT" };
const ownerCol = (scope: StatScope): Col => (scope === "gang" ? GANG_ID : STEAM);

/**
 * The whole SQL surface, generated per {@link Dialect} (sqlite | mysql | postgres). Table layout is
 * upstream-compatible: `<p>_gangs`, `<p>_players`, `<p>_ranks`, one instance table per native stat
 * (`<p>_gang_stats_<id>` / `<p>_player_stats_<id>`), plus one key/value table per scope
 * (`<p>_gang_stat_values` / `<p>_player_stat_values`) for every other stat id (e.g. `perk:<id>`),
 * whose values are stored as JSON text.
 */
export class GangsRepo {
  private readonly p: string;
  readonly d: Dialect;
  constructor(private readonly db: Db, prefix: string, dialect: DialectName = "sqlite") {
    this.p = ident(prefix);
    this.d = new Dialect(dialect);
  }

  private get gangs(): string { return `${this.p}_gangs`; }
  private get players(): string { return `${this.p}_players`; }
  private get ranks(): string { return `${this.p}_ranks`; }
  private statTable(scope: StatScope, statId: string): string { return `${this.p}_${scope}_stats_${ident(statId)}`; }
  private kvTable(scope: StatScope): string { return `${this.p}_${scope}_stat_values`; }

  /** Quote helper: `t` table / column. */
  private q(name: string): string { return this.d.q(name); }
  /** `"Col" = CAST(? AS type)` */
  private eq(c: Col): string { return `${this.q(c.name)} = ${this.d.param(c.type)}`; }
  private steamText(): string { return `${this.d.castText(this.q("Steam"))} AS ${this.q("Steam")}`; }
  private playerCols(): string {
    return [this.steamText(), this.q("Name"), this.q("GangId"), this.q("GangRank")].join(", ");
  }

  /** Every DDL statement, in order (exposed for dialect tests). */
  ddl(): string[] {
    const d = this.d;
    const out = [
      d.createTable(this.gangs, [GANG_ID, { ...NAME, notNull: true }], ["GangId"]),
      d.createTable(this.players, [STEAM, NAME, { name: "GangId", type: "INT" }, { name: "GangRank", type: "INT" }], ["Steam"]),
      d.createTable(this.ranks, [{ name: "GangId", type: "INT" }, RANK, { ...NAME, notNull: true }, { ...PERMS, notNull: true }], ["GangId", "Rank"]),
    ];
    for (const desc of [...NATIVE_GANG_STATS, ...NATIVE_PLAYER_STATS]) {
      const cols = columnsOf(desc).map(([n, t]) => ({ name: ident(n), type: t }));
      const owner = ownerCol(desc.scope);
      out.push(d.createTable(this.statTable(desc.scope, desc.id), [owner, ...cols], [owner.name]));
    }
    for (const scope of ["gang", "player"] as const) {
      const owner = ownerCol(scope);
      out.push(d.createTable(this.kvTable(scope), [owner, STAT_ID, VALUE], [owner.name, "StatId"]));
    }
    return out;
  }

  async ensureTables(): Promise<void> {
    for (const sql of this.ddl()) await this.db.execute(sql);
  }

  // ── loads ─────────────────────────────────────────────────────────────────────────────────────
  private async loadStats(scope: StatScope, where: string, params: SqlValue[]): Promise<StatRow[]> {
    const out: StatRow[] = [];
    const key = `${scope === "gang" ? this.q("GangId") : this.d.castText(this.q("Steam"))} AS ${this.q("K")}`;
    for (const desc of scope === "gang" ? NATIVE_GANG_STATS : NATIVE_PLAYER_STATS) {
      const cols = columnsOf(desc).map(([n]) => this.q(n)).join(", ");
      const rows = await this.db.query(`SELECT ${key}, ${cols} FROM ${this.q(this.statTable(scope, desc.id))} ${where}`, params);
      for (const r of rows) out.push({ owner: String(r.K), statId: desc.id, value: readNative(desc, r) });
    }
    const kv = await this.db.query(
      `SELECT ${key}, ${this.q("StatId")}, ${this.q("Value")} FROM ${this.q(this.kvTable(scope))} ${where}`, params,
    );
    for (const r of kv) out.push({ owner: String(r.K), statId: String(r.StatId), value: decodeValue(r.Value) });
    return out;
  }

  async loadAll(): Promise<Snapshot> {
    const q = (n: string) => this.q(n);
    const gangs = (await this.db.query(`SELECT ${q("GangId")}, ${q("Name")} FROM ${q(this.gangs)}`)).map(toGang);
    const ranks = (await this.db.query(
      `SELECT ${q("GangId")}, ${q("Rank")}, ${q("Name")}, ${q("Permissions")} FROM ${q(this.ranks)}`,
    )).map((r) => ({ gangId: Number(r.GangId), rank: toRank(r) }));
    const members = (await this.db.query(
      `SELECT ${this.playerCols()} FROM ${q(this.players)} WHERE ${q("GangId")} IS NOT NULL`,
    )).map(toPlayer);
    const gangStats = await this.loadStats("gang", "", []);
    const memberStats = await this.loadStats(
      "player",
      `WHERE ${q("Steam")} IN (SELECT ${q("Steam")} FROM ${q(this.players)} WHERE ${q("GangId")} IS NOT NULL)`,
      [],
    );
    return { gangs, ranks, members, gangStats, memberStats };
  }

  /** One player's row (inserted if missing, with `name`) and their stats. */
  async loadPlayer(steam: string, name: string | null): Promise<PlayerSnapshot> {
    const rows = await this.db.query(
      `SELECT ${this.playerCols()} FROM ${this.q(this.players)} WHERE ${this.eq(STEAM)}`, [steam],
    );
    let player = rows.length ? toPlayer(rows[0]) : null;
    if (!player) {
      await this.db.execute(
        `INSERT INTO ${this.q(this.players)} (${this.q("Steam")}, ${this.q("Name")}) ` +
        `VALUES (${this.d.param(STEAM.type)}, ${this.d.param(NAME.type)})`,
        [steam, name],
      );
      player = { steam, name, gangId: null, gangRank: null };
    }
    const stats = await this.loadStats("player", `WHERE ${this.eq(STEAM)}`, [steam]);
    return { player, stats };
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────
  async insertGang(gang: Gang): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.q(this.gangs)} (${this.q("GangId")}, ${this.q("Name")}) ` +
      `VALUES (${this.d.param(GANG_ID.type)}, ${this.d.param(NAME.type)})`,
      [gang.gangId, gang.name],
    );
  }
  async renameGang(gangId: number, name: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.q(this.gangs)} SET ${this.eq(NAME)} WHERE ${this.eq(GANG_ID)}`, [name, gangId]);
  }
  /** Remove a gang, its ranks, its stats, and every membership pointing at it. */
  async deleteGang(gangId: number): Promise<void> {
    const q = (n: string) => this.q(n);
    const byGang = `WHERE ${this.eq({ name: "GangId", type: "INT" })}`;
    await this.db.execute(
      `UPDATE ${q(this.players)} SET ${q("GangId")} = NULL, ${q("GangRank")} = NULL ${byGang}`, [gangId],
    );
    await this.db.execute(`DELETE FROM ${q(this.ranks)} ${byGang}`, [gangId]);
    for (const desc of NATIVE_GANG_STATS)
      await this.db.execute(`DELETE FROM ${q(this.statTable("gang", desc.id))} WHERE ${this.eq(GANG_ID)}`, [gangId]);
    await this.db.execute(`DELETE FROM ${q(this.kvTable("gang"))} WHERE ${this.eq(GANG_ID)}`, [gangId]);
    await this.db.execute(`DELETE FROM ${q(this.gangs)} WHERE ${this.eq(GANG_ID)}`, [gangId]);
  }

  async upsertPlayer(p: GangPlayer): Promise<void> {
    await this.db.execute(
      this.d.upsert(this.players, [STEAM], [NAME, { name: "GangId", type: "INT" }, { name: "GangRank", type: "INT" }]),
      [p.steam, p.name, p.gangId, p.gangRank],
    );
  }

  async insertRank(gangId: number, r: GangRank): Promise<void> {
    const cols = [{ name: "GangId", type: "INT" }, RANK, NAME, PERMS];
    await this.db.execute(
      `INSERT INTO ${this.q(this.ranks)} (${cols.map((c) => this.q(c.name)).join(", ")}) ` +
      `VALUES (${cols.map((c) => this.d.param(c.type)).join(", ")})`,
      [gangId, r.rank, r.name, r.permissions],
    );
  }
  async updateRank(gangId: number, r: GangRank): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.q(this.ranks)} SET ${this.eq(NAME)}, ${this.eq(PERMS)} ` +
      `WHERE ${this.eq({ name: "GangId", type: "INT" })} AND ${this.eq(RANK)}`,
      [r.name, r.permissions, gangId, r.rank],
    );
  }
  async deleteRank(gangId: number, rank: number): Promise<void> {
    await this.db.execute(
      `DELETE FROM ${this.q(this.ranks)} WHERE ${this.eq({ name: "GangId", type: "INT" })} AND ${this.eq(RANK)}`,
      [gangId, rank],
    );
  }

  /** Persist one stat value; `null` deletes the row. Native ids go to their instance table. */
  async writeStat(scope: StatScope, owner: string | number, statId: string, value: CachedStat): Promise<void> {
    const ownerC = ownerCol(scope);
    const desc = nativeDescriptor(scope, statId);
    if (!desc) {
      const t = this.q(this.kvTable(scope));
      if (value === null) {
        await this.db.execute(`DELETE FROM ${t} WHERE ${this.eq(ownerC)} AND ${this.eq(STAT_ID)}`, [owner, statId]);
        return;
      }
      if (isRecord(value)) throw new Error(`record value for non-native stat ${statId}`);
      await this.db.execute(this.d.upsert(this.kvTable(scope), [ownerC, STAT_ID], [VALUE]), [owner, statId, encodeValue(value)]);
      return;
    }
    const table = this.statTable(scope, desc.id);
    if (value === null) {
      await this.db.execute(`DELETE FROM ${this.q(table)} WHERE ${this.eq(ownerC)}`, [owner]);
      return;
    }
    const cols = columnsOf(desc).map(([n, t]) => ({ name: n, type: t }));
    const values: SqlValue[] = desc.kind === "scalar"
      ? [isRecord(value) ? null : value]
      : cols.map((c) => (isRecord(value) ? value[c.name] ?? null : null));
    await this.db.execute(this.d.upsert(table, [ownerC], cols), [owner, ...values]);
  }
}

function readNative(d: StatDescriptor, r: Row): CachedStat {
  if (d.kind === "scalar") return fromColumn(d.column, r[d.id] ?? null);
  const rec: Record<string, SqlValue> = {};
  for (const [n] of columnsOf(d)) rec[n] = r[n] ?? null;
  return rec;
}

export type { StatValue };
