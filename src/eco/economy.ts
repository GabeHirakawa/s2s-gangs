import type { GangService } from "../service/gang-service";
import { BALANCE_STAT } from "../store/stats";
import { Perm } from "../domain/perm";

const isAmount = (n: number): boolean => Number.isSafeInteger(n);

/**
 * Credits: a per-player wallet and a per-gang bank, both the upstream `gang_native_balance` stat.
 * Synchronous over the service cache. Balances never go below zero (a negative grant is clamped and
 * the event reports the delta actually applied), so -1 is an unambiguous "could not" sentinel.
 */
export class Economy {
  constructor(private readonly svc: GangService) {}

  wallet(steam: string): number {
    const v = this.svc.playerStat(steam, BALANCE_STAT);
    return typeof v === "number" ? v : 0;
  }

  getGangBalance(gangId: number): number {
    const v = this.svc.gangStat(gangId, BALANCE_STAT);
    return typeof v === "number" ? v : 0;
  }

  /** The gang bank this member may spend from (BANK_WITHDRAW), else 0. */
  private spendableBank(steam: string): { gangId: number; bank: number } | null {
    const p = this.svc.getPlayer(steam);
    if (!p || p.gangId === null || !this.svc.hasPermission(steam, Perm.BANK_WITHDRAW)) return null;
    return { gangId: p.gangId, bank: this.getGangBalance(p.gangId) };
  }

  /** Wallet plus (unless `excludeGang`) the spendable gang bank. */
  getBalance(steam: string, excludeGang: boolean): number {
    const wallet = this.wallet(steam);
    if (excludeGang) return wallet;
    return wallet + (this.spendableBank(steam)?.bank ?? 0);
  }

  /** New wallet balance, or -1 if not ready / player not loaded / invalid amount. */
  grantPlayer(steam: string, amount: number, reason: string): number {
    if (!isAmount(amount) || !this.svc.isLoaded(steam)) return -1;
    const before = this.wallet(steam);
    const next = Math.max(0, before + amount);
    if (!this.svc.setPlayerStat(steam, BALANCE_STAT, next)) return -1;
    if (next !== before)
      this.svc.emit("OnBalanceChanged", { kind: "player", steamId: steam, balance: next, delta: next - before, reason });
    return next;
  }

  /** New bank balance, or -1 for an unknown gang / invalid amount. */
  grantGang(gangId: number, amount: number, reason: string): number {
    if (!isAmount(amount) || !this.svc.getGang(gangId)) return -1;
    const before = this.getGangBalance(gangId);
    const next = Math.max(0, before + amount);
    if (!this.svc.setGangStat(gangId, BALANCE_STAT, next)) return -1;
    if (next !== before)
      this.svc.emit("OnBalanceChanged", { kind: "gang", gangId, balance: next, delta: next - before, reason });
    return next;
  }

  /**
   * Charge `cost`, gang bank first (unless `excludeGang`), then the wallet. Returns the remaining
   * spendable balance (same `excludeGang` view), or -1 if it cannot be afforded — nothing charged.
   */
  tryPurchase(steam: string, cost: number, reason: string, excludeGang: boolean): number {
    if (!isAmount(cost) || cost < 0 || !this.svc.isLoaded(steam)) return -1;
    const total = this.getBalance(steam, excludeGang);
    if (total < cost) return -1;
    let due = cost;
    const bank = excludeGang ? null : this.spendableBank(steam);
    if (bank && bank.bank > 0 && due > 0) {
      const fromGang = Math.min(bank.bank, due);
      this.grantGang(bank.gangId, -fromGang, reason);
      due -= fromGang;
    }
    if (due > 0) this.grantPlayer(steam, -due, reason);
    return total - cost;
  }
}
