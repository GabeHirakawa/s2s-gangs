/**
 * @gangs/api — the published inter-plugin contract for the Gangs plugin.
 *
 * This file is SELF-CONTAINED (no relative imports) so other plugins can vendor it directly:
 * copy it into your plugin (e.g. `types/gangs-api.d.ts`), declare
 * `"s2script": { "pluginDependencies": { "@gangs/api": "^0.1.0" } }` (or
 * `optionalPluginDependencies` for a soft dep) in package.json, then:
 *
 *   import type { GangsApi } from "./types/gangs-api";
 *   const gangs = ctx.use<GangsApi>("@gangs/api");        // hard dep
 *   // const gangs = ctx.tryUse<GangsApi>("@gangs/api");  // soft dep (null until published)
 *   gangs.on("member_joined", (e) => { ... });
 *   const bal = await gangs.eco.getBalance(steam);
 *
 * Values crossing the publish boundary are structured-copied (plain JSON) — never live references.
 * SteamID64s are always strings. Credits/ranks/gangIds are plain numbers.
 *
 * NOTE: keep this in sync with the plugin's internal `api.d.ts` — both describe the same `GangsApi`.
 * The internal file re-exports the plugin's own runtime types; this one inlines everything for export.
 */

/** A gang. */
export interface Gang {
  gangId: number;
  name: string;
}

/** A tracked player. `gangId`/`gangRank` are both null (no gang) or both set. */
export interface GangPlayer {
  steam: string;
  name: string | null;
  gangId: number | null;
  gangRank: number | null;
}

/** A rank within a gang. Lower `rank` number = higher standing; 0 = owner. `permissions` is a Perm bitfield. */
export interface GangRank {
  rank: number;
  name: string;
  permissions: number;
}

/** A resolved membership bundle. */
export interface Membership {
  player: GangPlayer;
  gang: Gang;
  rank: GangRank;
}

/** Door policy (stored int). 0 = REQUEST_ONLY, 1 = INVITE_ONLY, 2 = OPEN. */
export type DoorPolicy = 0 | 1 | 2;

/** Rank-deletion strategy. 0 = CANCEL, 1 = DEMOTE_FAIL, 2 = DEMOTE_KICK. */
export type DeleteStrat = 0 | 1 | 2;

/**
 * Permission bitfield values (subset used by consumers). `GangRank.permissions` is an OR of these.
 * Test membership with `(permissions & Perm.X) === Perm.X`.
 */
export declare const Perm: {
  readonly NONE: 0;
  readonly INVITE_OTHERS: number;
  readonly KICK_OTHERS: number;
  readonly BANK_DEPOSIT: number;
  readonly BANK_WITHDRAW: number;
  readonly PROMOTE_OTHERS: number;
  readonly DEMOTE_OTHERS: number;
  readonly PURCHASE_PERKS: number;
  readonly MANAGE_PERKS: number;
  readonly MANAGE_RANKS: number;
  readonly CREATE_RANKS: number;
  readonly VIEW_MEMBER_DETAILS: number;
  readonly SEND_GANG_CHAT: number;
  readonly MANAGE_INVITES: number;
  readonly ADMINISTRATOR: number;
  readonly OWNER: number;
};

/** A stat column type. */
export type ColumnType = "INT" | "BIGINT" | "VARCHAR(255)" | "REAL" | "BOOLEAN";
/** Which entity a stat is keyed on. */
export type StatScope = "gang" | "player";
/** A single-column stat (one value named by its id). */
export interface ScalarStat { id: string; scope: StatScope; kind: "scalar"; column: ColumnType; }
/** A multi-column stat (one column per field). */
export interface RecordStat { id: string; scope: StatScope; kind: "record"; columns: Record<string, ColumnType>; }
/** A stat's storage shape, passed to `stats.register`. */
export type StatDescriptor = ScalarStat | RecordStat;

/** Lifecycle events forwarded to consumers via `gangs.on(event, handler)`. */
export interface GangEvents {
  gang_created: { gangId: number; name: string; ownerSteam: string };
  gang_deleted: { gangId: number };
  gang_renamed: { gangId: number; name: string };
  member_joined: { gangId: number; steam: string; rank: number };
  member_left: { gangId: number; steam: string; reason: "leave" | "kick" | "disband" };
  member_rank_changed: { gangId: number; steam: string; oldRank: number; newRank: number };
  invite_created: { gangId: number; inviter: string; invited: string };
  invite_revoked: { gangId: number; invited: string };
  player_credits_changed: { steam: string; balance: number; delta: number; reason: string | null };
  gang_credits_changed: { gangId: number; balance: number; delta: number; reason: string | null };
}

/** Result of `perks.purchase`. */
export type PurchaseResult = {
  ok: boolean;
  reason: "ok" | "unknown_perk" | "not_in_gang" | "no_permission" | "unpurchasable" | "insufficient_funds";
  cost?: number;
  balance?: number;
};

/** The published `@gangs/api` surface. Resolve with `ctx.use<GangsApi>("@gangs/api")`. */
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
    add(gangId: number, steam: string, rank: number): Promise<boolean>;
    remove(steam: string, reason: "leave" | "kick" | "disband"): Promise<boolean>;
    setRank(steam: string, newRank: number): Promise<boolean>;
  };
  invites: {
    create(gangId: number, inviter: string, invited: string, nowSec: number): Promise<boolean>;
    revoke(gangId: number, invited: string): Promise<boolean>;
    outgoing(gangId: number): Promise<string[]>;
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
  /** Subscribe to a forwarded lifecycle event. Load-window only (register inside the factory). */
  on<K extends keyof GangEvents>(event: K, handler: (payload: GangEvents[K]) => void): void;
}
