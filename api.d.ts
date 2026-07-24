export type { Gang, GangPlayer, GangRank, Membership } from "./src/domain/types";
export { DoorPolicy, DeleteStrat } from "./src/domain/types";
export { Perm } from "./src/domain/perm";
export type { StatDescriptor } from "./src/db/instance.repo";
export type { GangEvents } from "./src/api/events";
import type { Gang, GangPlayer, GangRank, Membership, DeleteStrat } from "./src/domain/types";
import type { StatDescriptor } from "./src/db/instance.repo";

export interface GangsApi {
  gangs: {
    getAll(): Promise<Gang[]>;
    get(id: number): Promise<Gang | null>;
    getByMember(steam: string): Promise<Gang | null>;
    create(name: string, ownerSteam: string): Promise<Gang | null>;
    updateName(gangId: number, name: string): Promise<boolean>;
    delete(id: number): Promise<boolean>;
  };
  players: {
    get(steam: string, create?: boolean): Promise<GangPlayer | null>;
    create(steam: string, name?: string | null): Promise<GangPlayer>;
    getAll(): Promise<GangPlayer[]>;
    getMembers(gangId: number): Promise<GangPlayer[]>;
    findInGang(gangId: number, query: string): Promise<GangPlayer | null>;
    getMembership(steam: string): Promise<Membership | null>;
    update(p: GangPlayer): Promise<boolean>;
    delete(steam: string): Promise<boolean>;
  };
  members: {
    /** Assign a player into a gang at `rank`; emits `member_joined`. */
    add(gangId: number, steam: string, rank: number): Promise<boolean>;
    /** Remove a player from their gang; emits `member_left` with the reason. */
    remove(steam: string, reason: "leave" | "kick" | "disband"): Promise<boolean>;
    /** Change a member's rank; emits `member_rank_changed`. */
    setRank(steam: string, newRank: number): Promise<boolean>;
  };
  invites: {
    /** Record an outgoing invite (+ the target's pending list); emits `invite_created`. */
    create(gangId: number, inviter: string, invited: string, nowSec: number): Promise<boolean>;
    /** Remove an outgoing invite (+ the target's pending entry); emits `invite_revoked`. */
    revoke(gangId: number, invited: string): Promise<boolean>;
    /** SteamID64s the gang has invited. */
    outgoing(gangId: number): Promise<string[]>;
    /** Gang ids that have invited the player. */
    pending(steam: string): Promise<number[]>;
  };
  ranks: {
    getAll(gangId: number): Promise<GangRank[]>;
    get(gangId: number, rank: number): Promise<GangRank | null>;
    create(gangId: number, name: string, rank: number, permissions: number): Promise<GangRank | null>;
    update(gangId: number, rank: GangRank): Promise<boolean>;
    delete(gangId: number, rank: number, strat: DeleteStrat): Promise<boolean>;
    setPermission(gangId: number, rank: number, perm: number, on: boolean): Promise<boolean>;
    assignDefaults(gangId: number): Promise<GangRank[]>;
    checkPermission(steam: string, perm: number): Promise<boolean>;
    getJoinRank(gangId: number): Promise<GangRank | null>;
    getRankNeeded(gangId: number, perm: number): Promise<GangRank | null>;
  };
  stats: {
    register(d: StatDescriptor): void;
    getForGang<T>(gangId: number, statId: string): Promise<T | null>;
    setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean>;
    removeFromGang(gangId: number, statId: string): Promise<boolean>;
    getForPlayer<T>(steam: string, statId: string): Promise<T | null>;
    setForPlayer<T>(steam: string, statId: string, value: T): Promise<boolean>;
    removeFromPlayer(steam: string, statId: string): Promise<boolean>;
  };
  eco: {
    getBalance(steam: string, excludeGangCredits?: boolean): Promise<number>;
    getGangBalance(gangId: number): Promise<number>;
    canAfford(steam: string, cost: number, excludeGangCredits?: boolean): Promise<boolean>;
    tryPurchase(steam: string, cost: number, opts?: { excludeGangCredits?: boolean }): Promise<number>;
    grantPlayer(steam: string, amount: number, reason?: string): Promise<number>;
    grantGang(gangId: number, amount: number, reason?: string): Promise<number>;
  };
  perks: {
    list(): { id: string; name: string; description: string }[];
    getCost(gangId: number, perkId: string): Promise<number | null>;
    getCapacity(gangId: number): Promise<number>;
    purchase(steam: string, perkId: string): Promise<PurchaseResult>;
  };
}

export type PurchaseResult = {
  ok: boolean;
  reason: "ok" | "unknown_perk" | "not_in_gang" | "no_permission" | "unpurchasable" | "insufficient_funds";
  cost?: number;
  balance?: number;
};
