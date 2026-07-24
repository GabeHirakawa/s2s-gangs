import type { Db, Row } from "./db";
import type { GangPlayer } from "../domain/types";

const toPlayer = (r: Row): GangPlayer => ({
  steam: String(r.Steam),
  name: r.Name === null ? null : String(r.Name),
  gangId: r.GangId === null ? null : Number(r.GangId),
  gangRank: r.GangRank === null ? null : Number(r.GangRank),
});

const SELECT = "SELECT CAST(Steam AS TEXT) AS Steam, Name, GangId, GangRank";

export class PlayersRepo {
  constructor(private db: Db, private prefix: string) {}
  private get t(): string { return `${this.prefix}_players`; }

  async get(steam: string): Promise<GangPlayer | null> {
    const rows = await this.db.query(`${SELECT} FROM ${this.t} WHERE Steam = ?`, [steam]);
    return rows.length ? toPlayer(rows[0]) : null;
  }
  async insert(steam: string, name: string | null): Promise<void> {
    await this.db.execute(`INSERT INTO ${this.t} (Steam, Name) VALUES (?, ?)`, [steam, name]);
  }
  async all(): Promise<GangPlayer[]> {
    return (await this.db.query(`${SELECT} FROM ${this.t}`)).map(toPlayer);
  }
  async members(gangId: number): Promise<GangPlayer[]> {
    return (await this.db.query(
      `${SELECT} FROM ${this.t} WHERE GangId = ? ORDER BY GangRank ASC`, [gangId]
    )).map(toPlayer);
  }
  async update(p: GangPlayer): Promise<boolean> {
    const res = await this.db.execute(
      `UPDATE ${this.t} SET Name = ?, GangId = ?, GangRank = ? WHERE Steam = ?`,
      [p.name, p.gangId, p.gangRank, p.steam]
    );
    return res.changes === 1;
  }
  async delete(steam: string): Promise<boolean> {
    const res = await this.db.execute(`DELETE FROM ${this.t} WHERE Steam = ?`, [steam]);
    return res.changes === 1;
  }
}
