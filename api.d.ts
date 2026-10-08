/**
 * @edgegamers/gangs — the Gangs service contract (s2script interop protocol 2).
 *
 * Every method is SYNCHRONOUS and answers from the plugin's in-memory cache. Gangs loads every
 * gang, rank, gang stat and gang member at start, and each connecting player's own row on
 * connect; writes update the cache immediately and are persisted to the database in the
 * background (ordered, logged on failure). Until the initial load finishes, `isReady()` is false,
 * reads return empty/null/0 and writes return false — subscribe to `OnReady` to know when it flips.
 *
 * Identity rules:
 * - Players are identified by canonical decimal SteamID64 strings (never JS numbers).
 * - Gangs are identified by positive integer ids.
 * - Stat values are `string | number | boolean | null`; structured values belong in a JSON string.
 *
 * This file is self-contained: a consumer outside this repository checks in a verbatim copy at
 * `.s2script/types/@edgegamers/gangs/index.d.ts` (or runs `s2s add @edgegamers/gangs`).
 */
import type { Notification } from "@s2script/sdk/interfaces";

/** A gang. */
export interface Gang {
  id: number;
  name: string;
}

/** A gang member. Rank 0 is the owner; larger numbers are lower ranks. */
export interface Member {
  steamId: string;
  /** Last known display name; "" if never seen. */
  name: string;
  gangId: number;
  rank: number;
}

/** A rank within one gang. */
export interface Rank {
  rank: number;
  name: string;
  /** Bitmask of {@link Perm} flags. */
  permissions: number;
}

/** A stored stat value. Use a JSON string for anything structured. */
export type StatValue = string | number | boolean | null;

/**
 * A perk contributed by another plugin. Gangs lists it in `sm_gang_perks` and the gang menu.
 *
 * - A **levelled** perk supplies `costs`: `costs[n]` is the price of going from level `n` to
 *   `n + 1`. Gangs owns the purchase (permission + funds), stores the level in the gang stat
 *   `perk:<id>`, and emits `OnPerkPurchased`. Read it back with `getPerkLevel`.
 * - A **custom** perk supplies `command` instead (e.g. `"sm_wardenicon"`): choosing it in the
 *   menu runs that command as the player. The providing plugin owns pricing, unlocking and state
 *   (typically via `tryPurchase` + gang stats).
 */
export interface PerkSpec {
  id: string;
  name: string;
  description: string;
  costs?: number[];
  command?: string;
}

/** A registered perk as listed to players. */
export interface PerkInfo {
  id: string;
  name: string;
  description: string;
  /** "native" for Gangs' own perks, otherwise the registering plugin's id. */
  provider: string;
  /** Present for levelled perks: the number of levels. */
  maxLevel?: number;
  /** Present for custom perks. */
  command?: string;
}

/** Why a purchase did or did not go through. */
export type PurchaseReason =
  | "ok"
  | "not_ready"
  | "unknown_perk"
  | "not_in_gang"
  | "no_permission"
  | "max_level"
  | "insufficient_funds";

export interface PurchaseResult {
  ok: boolean;
  reason: PurchaseReason;
  /** The price that was (or would have been) charged. */
  cost?: number;
  /** The perk level after an ok purchase. */
  level?: number;
}

export interface GangEvent {
  gangId: number;
  name: string;
}

export interface MemberEvent {
  gangId: number;
  steamId: string;
  rank: number;
}

export interface MemberLeftEvent {
  gangId: number;
  steamId: string;
  reason: "leave" | "kick" | "disband";
}

export interface RankChangedEvent {
  gangId: number;
  steamId: string;
  oldRank: number;
  newRank: number;
}

export interface PerkPurchasedEvent {
  gangId: number;
  steamId: string;
  perkId: string;
  level: number;
  cost: number;
}

export interface BalanceChangedEvent {
  /** "player" balances are keyed by steamId; "gang" balances by gangId. */
  kind: "player" | "gang";
  steamId?: string;
  gangId?: number;
  balance: number;
  delta: number;
  reason: string;
}

export interface ReadyEvent {
  gangs: number;
}

/**
 * Rank permission bits used by {@link GangsApi.hasPermission} (contracts cannot export constants):
 * INVITE_OTHERS 1<<0 · KICK_OTHERS 1<<1 · BANK_DEPOSIT 1<<2 · BANK_WITHDRAW 1<<3 ·
 * PROMOTE_OTHERS 1<<4 · DEMOTE_OTHERS 1<<5 · PURCHASE_PERKS 1<<6 · MANAGE_PERKS 1<<7 ·
 * MANAGE_RANKS 1<<8 · CREATE_RANKS 1<<9 · ADMINISTRATOR 1<<10 · OWNER 1<<11 ·
 * VIEW_MEMBER_DETAILS 1<<12 · MANAGE_INVITES 1<<13 · SEND_GANG_CHAT 1<<14.
 */
export type PermBits = number;

export interface GangsApi {
  /** True once the initial cache load has finished. */
  isReady(): boolean;

  // ── gangs & membership ────────────────────────────────────────────────────────────
  getGang(gangId: number): Gang | null;
  /** The gang `steamId` belongs to, or null. */
  getGangOf(steamId: string): Gang | null;
  getMember(steamId: string): Member | null;
  getMembers(gangId: number): Member[];
  /** Ranks of a gang, ordered owner-first. */
  getRanks(gangId: number): Rank[];
  /** True if the member's rank grants every bit of `perm` (see {@link PermBits}). */
  hasPermission(steamId: string, perm: PermBits): boolean;

  // ── stats ─────────────────────────────────────────────────────────────────────────
  getGangStat(gangId: number, statId: string): StatValue;
  setGangStat(gangId: number, statId: string, value: StatValue): boolean;
  getPlayerStat(steamId: string, statId: string): StatValue;
  setPlayerStat(steamId: string, statId: string, value: StatValue): boolean;

  // ── economy ───────────────────────────────────────────────────────────────────────
  /** Spendable balance: the wallet plus, unless `excludeGang`, the gang bank. */
  getBalance(steamId: string, excludeGang: boolean): number;
  getGangBalance(gangId: number): number;
  /**
   * Charge `cost`, drawing from the gang bank first (unless `excludeGang`) then the wallet.
   * Returns the remaining spendable balance, or -1 if it could not be afforded (nothing charged).
   */
  tryPurchase(steamId: string, cost: number, reason: string, excludeGang: boolean): number;
  /** Add (or with a negative amount, remove) wallet credits. Returns the new wallet balance. */
  grantPlayer(steamId: string, amount: number, reason: string): number;
  /** Add (or remove) gang bank credits. Returns the new bank balance, or -1 for an unknown gang. */
  grantGang(gangId: number, amount: number, reason: string): number;

  // ── perks ─────────────────────────────────────────────────────────────────────────
  /**
   * Register a perk from another plugin. `provider` is the caller's own plugin id
   * (`pluginId()`); the perk is listed only while that plugin is running, and re-registering the
   * same id from the same provider replaces it. Returns false for an invalid spec or an id owned
   * by a different provider. Call it from the provider's OnReady/attach path, not load time.
   */
  registerPerk(provider: string, spec: PerkSpec): boolean;
  listPerks(): PerkInfo[];
  /** Current level of a levelled perk (0 = not owned). */
  getPerkLevel(gangId: number, perkId: string): number;
  /** Buy the next level of a levelled perk for the player's gang. */
  purchasePerk(steamId: string, perkId: string): PurchaseResult;

  // ── chat ──────────────────────────────────────────────────────────────────────────
  /** Print a line, with the gang-chat prefix, to every online member of the gang. */
  sendGangChat(gangId: number, message: string): void;
}

/** Method exports (direct imports: `import { getGangOf } from "@edgegamers/gangs"`). */
export declare function isReady(): boolean;
export declare function getGang(gangId: number): Gang | null;
export declare function getGangOf(steamId: string): Gang | null;
export declare function getMember(steamId: string): Member | null;
export declare function getMembers(gangId: number): Member[];
export declare function getRanks(gangId: number): Rank[];
export declare function hasPermission(steamId: string, perm: number): boolean;
export declare function getGangStat(gangId: number, statId: string): StatValue;
export declare function setGangStat(gangId: number, statId: string, value: StatValue): boolean;
export declare function getPlayerStat(steamId: string, statId: string): StatValue;
export declare function setPlayerStat(steamId: string, statId: string, value: StatValue): boolean;
export declare function getBalance(steamId: string, excludeGang: boolean): number;
export declare function getGangBalance(gangId: number): number;
export declare function tryPurchase(steamId: string, cost: number, reason: string, excludeGang: boolean): number;
export declare function grantPlayer(steamId: string, amount: number, reason: string): number;
export declare function grantGang(gangId: number, amount: number, reason: string): number;
export declare function registerPerk(provider: string, spec: PerkSpec): boolean;
export declare function listPerks(): PerkInfo[];
export declare function getPerkLevel(gangId: number, perkId: string): number;
export declare function purchasePerk(steamId: string, perkId: string): PurchaseResult;
export declare function sendGangChat(gangId: number, message: string): void;

export interface Contract {
  methods: GangsApi;
  forwards: {
    OnReady: Notification<ReadyEvent>;
    OnGangCreated: Notification<GangEvent>;
    OnGangDisbanded: Notification<GangEvent>;
    OnGangRenamed: Notification<GangEvent>;
    OnMemberJoined: Notification<MemberEvent>;
    OnMemberLeft: Notification<MemberLeftEvent>;
    OnMemberRankChanged: Notification<RankChangedEvent>;
    OnPerkPurchased: Notification<PerkPurchasedEvent>;
    OnBalanceChanged: Notification<BalanceChangedEvent>;
  };
}
