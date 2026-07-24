import type { Db, Row } from "./db";
import type { GangRank } from "../domain/types";

const toRank = (r: Row): GangRank => ({
  rank: Number(r.Rank), name: String(r.Name), permissions: Number(r.Permissions),
});

export class RanksRepo {
  constructor(private db: Db, private prefix: string) {}
  private get t(): string { return `${this.prefix}_ranks`; }

  async forGang(gangId: number): Promise<GangRank[]> {
    return (await this.db.query(
      "SELECT `Rank`, Name, Permissions FROM " + this.t + " WHERE GangId = ? ORDER BY `Rank` ASC",
      [gangId]
    )).map(toRank);
  }
  async get(gangId: number, rank: number): Promise<GangRank | null> {
    const rows = await this.db.query(
      "SELECT `Rank`, Name, Permissions FROM " + this.t + " WHERE GangId = ? AND `Rank` = ?",
      [gangId, rank]
    );
    return rows.length ? toRank(rows[0]) : null;
  }
  async insert(gangId: number, rank: GangRank): Promise<boolean> {
    const res = await this.db.execute(
      "INSERT INTO " + this.t + " (GangId, `Rank`, Name, Permissions) VALUES (?, ?, ?, ?)",
      [gangId, rank.rank, rank.name, rank.permissions]
    );
    return res.changes === 1;
  }
  async update(gangId: number, rank: GangRank): Promise<boolean> {
    const res = await this.db.execute(
      "UPDATE " + this.t + " SET Name = ?, Permissions = ? WHERE GangId = ? AND `Rank` = ?",
      [rank.name, rank.permissions, gangId, rank.rank]
    );
    return res.changes === 1;
  }
  async delete(gangId: number, rank: number): Promise<boolean> {
    const res = await this.db.execute(
      "DELETE FROM " + this.t + " WHERE GangId = ? AND `Rank` = ?", [gangId, rank]
    );
    return res.changes === 1;
  }
  async deleteAll(gangId: number): Promise<boolean> {
    const res = await this.db.execute("DELETE FROM " + this.t + " WHERE GangId = ?", [gangId]);
    return res.changes > 0;
  }
}
