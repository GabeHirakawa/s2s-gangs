import type { RanksRepo } from "../db/ranks.repo";
import type { PlayerManager } from "./player-manager";
import type { GangRank, GangPlayer } from "../domain/types";
import { DeleteStrat } from "../domain/types";
import { Perm, hasPerm, DEFAULT_RANKS } from "../domain/perm";

export class RankManager {
  constructor(private ranks: RanksRepo, private players: PlayerManager) {}

  getRanks(gangId: number): Promise<GangRank[]> { return this.ranks.forGang(gangId); }
  getRank(gangId: number, rank: number): Promise<GangRank | null> { return this.ranks.get(gangId, rank); }

  async addRank(gangId: number, rank: GangRank): Promise<boolean> {
    if (rank.rank < 0) return false;
    if (rank.rank > 0 && hasPerm(rank.permissions, Perm.OWNER)) return false; // only rank 0 may be OWNER
    if (await this.ranks.get(gangId, rank.rank)) return false;
    return this.ranks.insert(gangId, rank);
  }

  async createRank(gangId: number, name: string, rank: number, permissions: number): Promise<GangRank | null> {
    const obj: GangRank = { rank, name, permissions };
    return (await this.addRank(gangId, obj)) ? obj : null;
  }

  async updateRank(gangId: number, rank: GangRank): Promise<boolean> {
    if (rank.rank < 0) return false;
    if (rank.rank > 0 && hasPerm(rank.permissions, Perm.OWNER)) return false;
    return this.ranks.update(gangId, rank);
  }

  async deleteRank(gangId: number, rank: number, strat: DeleteStrat): Promise<boolean> {
    if (rank <= 0) return false;
    const members = (await this.players.getMembers(gangId)).filter((p) => p.gangRank === rank);
    if (strat === DeleteStrat.CANCEL && members.length > 0) return false;

    const all = await this.ranks.forGang(gangId);
    const lower = all.filter((r) => r.rank > rank).sort((a, b) => a.rank - b.rank)[0] ?? null;
    if (strat === DeleteStrat.DEMOTE_FAIL && lower === null && members.length > 0) return false;

    for (const p of members) {
      const next: GangPlayer = lower
        ? { ...p, gangId, gangRank: lower.rank }
        : { ...p, gangId: null, gangRank: null };
      await this.players.updatePlayer(next);
    }
    return this.ranks.delete(gangId, rank);
  }

  deleteAllRanks(gangId: number): Promise<boolean> { return this.ranks.deleteAll(gangId); }

  async assignDefaultRanks(gangId: number): Promise<GangRank[]> {
    const created: GangRank[] = [];
    for (const r of DEFAULT_RANKS) {
      const made = await this.createRank(gangId, r.name, r.rank, r.permissions);
      if (!made) throw new Error(`Failed to create default rank ${r.name}`);
      created.push(made);
    }
    return created;
  }

  async getJoinRank(gangId: number): Promise<GangRank | null> {
    const ranks = await this.ranks.forGang(gangId);
    return ranks.length ? ranks[ranks.length - 1] : null;
  }

  async getRankNeeded(gangId: number, perm: number): Promise<GangRank | null> {
    const ranks = await this.ranks.forGang(gangId);
    const withPerm = ranks.filter((r) => hasPerm(r.permissions, perm));
    return withPerm.length ? withPerm[withPerm.length - 1] : null;
  }

  async checkRank(player: GangPlayer, perm: number): Promise<{ ok: boolean; required: GangRank | null }> {
    if (player.gangId === null || player.gangRank === null) return { ok: false, required: null };
    const required = await this.getRankNeeded(player.gangId, perm);
    const rank = await this.ranks.get(player.gangId, player.gangRank);
    return { ok: rank !== null && hasPerm(rank.permissions, perm), required };
  }
}
