import type { GangsRepo } from "../db/gangs.repo";
import type { PlayerManager } from "./player-manager";
import type { RankManager } from "./rank-manager";
import type { Gang } from "../domain/types";

export class GangManager {
  constructor(private gangs: GangsRepo, private players: PlayerManager, private ranks: RankManager) {}

  getGangs(): Promise<Gang[]> { return this.gangs.all(); }
  getGang(id: number): Promise<Gang | null> { return this.gangs.get(id); }

  async getGangByMember(steam: string): Promise<Gang | null> {
    const player = await this.players.getPlayer(steam, false);
    if (!player || player.gangId === null) return null;
    return this.gangs.get(player.gangId);
  }

  async createGang(name: string, ownerSteam: string): Promise<Gang | null> {
    const player = await this.players.getPlayer(ownerSteam);
    if (!player) return null;
    if (player.gangId !== null) return null; // expected failure — already in a gang (design §7: no throw)

    const id = await this.gangs.insert(name);
    if (!id) return null;
    await this.ranks.assignDefaultRanks(id);
    await this.players.updatePlayer({ ...player, gangId: id, gangRank: 0 });
    return { gangId: id, name };
  }

  updateGang(gang: Gang): Promise<boolean> { return this.gangs.updateName(gang.gangId, gang.name); }

  async deleteGang(id: number): Promise<boolean> {
    const members = await this.players.getMembers(id);
    for (const m of members) await this.players.updatePlayer({ ...m, gangId: null, gangRank: null });
    await this.ranks.deleteAllRanks(id);
    return this.gangs.delete(id);
  }
}
