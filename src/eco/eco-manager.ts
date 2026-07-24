import type { StatManager } from "../managers/stat-manager";
import type { PlayerManager } from "../managers/player-manager";
import type { RankManager } from "../managers/rank-manager";
import { Perm, hasPerm } from "../domain/perm";
import { BALANCE_STAT_ID } from "./balance";

/** Sink for credit-change notifications; buildGangsApi adapts this to the publish emitter. */
export interface CreditsEmit {
  player(steam: string, balance: number, delta: number, reason: string | null): void;
  gang(gangId: number, balance: number, delta: number, reason: string | null): void;
}

export class EcoManager {
  constructor(
    private stats: StatManager,
    private players: PlayerManager,
    private ranks: RankManager,
    private emit?: CreditsEmit,
  ) {}

  async getGangBalance(gangId: number): Promise<number> {
    return (await this.stats.getForGang<number>(gangId, BALANCE_STAT_ID)) ?? 0;
  }

  private async playerBalance(steam: string): Promise<number> {
    return (await this.stats.getForPlayer<number>(steam, BALANCE_STAT_ID)) ?? 0;
  }

  /** [playerOnly, total]; total includes the gang bank iff the member has BANK_WITHDRAW. */
  private async balances(steam: string): Promise<[number, number]> {
    const player = await this.playerBalance(steam);
    const gp = await this.players.getPlayer(steam, false);
    if (!gp || gp.gangId === null || gp.gangRank === null) return [player, player];
    const rank = await this.ranks.getRank(gp.gangId, gp.gangRank);
    if (!rank || !hasPerm(rank.permissions, Perm.BANK_WITHDRAW)) return [player, player];
    const bank = await this.getGangBalance(gp.gangId);
    return [player, player + bank];
  }

  async getBalance(steam: string, excludeGangCredits = false): Promise<number> {
    const [player, total] = await this.balances(steam);
    return excludeGangCredits ? player : total;
  }

  async canAfford(steam: string, cost: number, excludeGangCredits = false): Promise<boolean> {
    return (await this.getBalance(steam, excludeGangCredits)) >= cost;
  }

  async grantPlayer(steam: string, amount: number, reason: string | null = null): Promise<number> {
    const next = (await this.playerBalance(steam)) + amount;
    await this.stats.setForPlayer(steam, BALANCE_STAT_ID, next);
    this.emit?.player(steam, next, amount, reason);
    return next;
  }

  async grantGang(gangId: number, amount: number, reason: string | null = null): Promise<number> {
    const next = (await this.getGangBalance(gangId)) + amount;
    await this.stats.setForGang(gangId, BALANCE_STAT_ID, next);
    this.emit?.gang(gangId, next, amount, reason);
    return next;
  }

  /** Remaining balance after the purchase; negative and no-op if unaffordable. Gang bank first. */
  async tryPurchase(steam: string, cost: number, excludeGangCredits = false): Promise<number> {
    const [player, total] = await this.balances(steam);
    const remaining = (excludeGangCredits ? player : total) - cost;
    if (remaining < 0) return remaining;

    let due = cost;
    const gp = await this.players.getPlayer(steam, false);
    const gangBank = total - player; // 0 unless the member can access the bank
    if (!excludeGangCredits && gp && gp.gangId !== null && gangBank > 0) {
      const fromGang = Math.min(gangBank, due);
      await this.grantGang(gp.gangId, -fromGang, "purchase");
      due -= fromGang;
    }
    if (due > 0) await this.grantPlayer(steam, -due, "purchase");
    return remaining;
  }
}
