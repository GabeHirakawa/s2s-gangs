import type { Db, Row } from "./db";
import type { Gang } from "../domain/types";

const toGang = (r: Row): Gang => ({ gangId: Number(r.GangId), name: String(r.Name) });

export class GangsRepo {
  constructor(private db: Db, private prefix: string) {}
  private get t(): string { return `${this.prefix}_gangs`; }

  async all(): Promise<Gang[]> {
    return (await this.db.query(`SELECT GangId, Name FROM ${this.t}`)).map(toGang);
  }
  async get(id: number): Promise<Gang | null> {
    const rows = await this.db.query(`SELECT GangId, Name FROM ${this.t} WHERE GangId = ?`, [id]);
    return rows.length ? toGang(rows[0]) : null;
  }
  async insert(name: string): Promise<number> {
    const res = await this.db.execute(`INSERT INTO ${this.t} (Name) VALUES (?)`, [name]);
    return res.lastInsertId;
  }
  async updateName(gangId: number, name: string): Promise<boolean> {
    const res = await this.db.execute(`UPDATE ${this.t} SET Name = ? WHERE GangId = ?`, [name, gangId]);
    return res.changes === 1;
  }
  async delete(id: number): Promise<boolean> {
    const res = await this.db.execute(`DELETE FROM ${this.t} WHERE GangId = ?`, [id]);
    return res.changes > 0;
  }
}
