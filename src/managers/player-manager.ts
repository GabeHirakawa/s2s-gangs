import type { PlayersRepo } from "../db/players.repo";
import type { GangPlayer } from "../domain/types";

export class PlayerManager {
  constructor(private players: PlayersRepo) {}

  async getPlayer(steam: string, create = true): Promise<GangPlayer | null> {
    const existing = await this.players.get(steam);
    if (existing || !create) return existing;
    return this.createPlayer(steam);
  }

  async createPlayer(steam: string, name: string | null = null): Promise<GangPlayer> {
    const existing = await this.players.get(steam);
    if (existing) return existing;
    await this.players.insert(steam, name);
    return { steam, name, gangId: null, gangRank: null };
  }

  getAllPlayers(): Promise<GangPlayer[]> { return this.players.all(); }
  getMembers(gangId: number): Promise<GangPlayer[]> { return this.players.members(gangId); }

  async findPlayerInGang(gangId: number, query: string): Promise<GangPlayer | null> {
    const members = await this.players.members(gangId);
    const bySteam = members.filter((p) => p.steam === query);
    if (bySteam.length === 1) return bySteam[0];
    const q = query.toLowerCase();
    const byName = members.filter((p) => p.name !== null && p.name.toLowerCase().includes(q));
    return byName.length === 1 ? byName[0] : null;
  }

  async updatePlayer(p: GangPlayer): Promise<boolean> {
    if ((p.gangId === null) !== (p.gangRank === null))
      throw new Error("Player must have both GangId and GangRank set or neither set");
    return this.players.update(p);
  }

  deletePlayer(steam: string): Promise<boolean> { return this.players.delete(steam); }
}
