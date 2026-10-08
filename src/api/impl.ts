import type { Gang as ApiGang, GangsApi, Member, PerkSpec, PurchaseResult, Rank, StatValue } from "../../api";
import type { GangService } from "../service/gang-service";
import type { Economy } from "../eco/economy";
import type { PerkCatalog } from "../perks/catalog";
import type { GangPlayer } from "../domain/types";
import { BALANCE_STAT, type CachedStat, type StatScope, fitsColumn, isRecord, nativeDescriptor } from "../store/stats";

const U64_MAX = "18446744073709551615";

/** A canonical, nonzero decimal SteamID64 (no sign, no leading zeros, fits in u64). */
export function isSteamId(v: string): boolean {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,19}$/.test(v)) return false;
  return v.length < 20 || v <= U64_MAX;
}
const isGangId = (v: number): boolean => Number.isSafeInteger(v) && v > 0;
const isStatId = (v: string): boolean => typeof v === "string" && v.length > 0 && v.length <= 255;
const isText = (v: string): boolean => typeof v === "string" && v.length <= 255;
const MAX_STAT_STRING = 4096;

function isStatValue(v: StatValue): boolean {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.length <= MAX_STAT_STRING;
}

/** Cache value → public StatValue (records — upstream multi-column stats — surface as JSON text). */
function publicValue(v: CachedStat): StatValue {
  return isRecord(v) ? JSON.stringify(v) : v;
}

/** Can a public caller write `value` to `statId`? Balances go through grant*; records are internal. */
function writable(scope: StatScope, statId: string, value: StatValue): boolean {
  if (!isStatId(statId) || !isStatValue(value)) return false;
  if (statId === BALANCE_STAT) return false;
  const d = nativeDescriptor(scope, statId);
  if (!d) return true;
  return d.kind === "scalar" && fitsColumn(d.column, value);
}

const toGang = (g: { gangId: number; name: string }): ApiGang => ({ id: g.gangId, name: g.name });
const toMember = (p: GangPlayer): Member => ({
  steamId: p.steam, name: p.name ?? "", gangId: p.gangId ?? 0, rank: p.gangRank ?? 0,
});

export interface ApiDeps {
  svc: GangService;
  eco: Economy;
  perks: PerkCatalog;
  /** Print `message` (already formatted) to every online member of `gangId`. */
  sendGangChat(gangId: number, message: string): void;
}

/**
 * The `@edgegamers/gangs` implementation: every method is synchronous over the service cache, validates
 * its (wire-copied) inputs, and returns plain data built fresh per call — never a cache reference.
 */
export function buildGangsApi(d: ApiDeps): GangsApi {
  const { svc, eco, perks } = d;
  const ready = (): boolean => svc.isReady();
  return {
    isReady: () => ready(),

    getGang(gangId: number): ApiGang | null {
      if (!isGangId(gangId)) return null;
      const g = svc.getGang(gangId);
      return g ? toGang(g) : null;
    },
    getGangOf(steamId: string): ApiGang | null {
      if (!isSteamId(steamId)) return null;
      const g = svc.gangOf(steamId);
      return g ? toGang(g) : null;
    },
    getMember(steamId: string): Member | null {
      if (!isSteamId(steamId)) return null;
      const p = svc.getPlayer(steamId);
      return p && p.gangId !== null && p.gangRank !== null ? toMember(p) : null;
    },
    getMembers(gangId: number): Member[] {
      return isGangId(gangId) ? svc.membersOf(gangId).map(toMember) : [];
    },
    getRanks(gangId: number): Rank[] {
      if (!isGangId(gangId)) return [];
      return svc.ranksOf(gangId).map((r) => ({ rank: r.rank, name: r.name, permissions: r.permissions }));
    },
    hasPermission(steamId: string, perm: number): boolean {
      if (!isSteamId(steamId) || !Number.isSafeInteger(perm) || perm < 0) return false;
      return svc.hasPermission(steamId, perm);
    },

    getGangStat(gangId: number, statId: string): StatValue {
      if (!isGangId(gangId) || !isStatId(statId)) return null;
      return publicValue(svc.gangStat(gangId, statId));
    },
    setGangStat(gangId: number, statId: string, value: StatValue): boolean {
      if (!ready() || !isGangId(gangId) || !writable("gang", statId, value)) return false;
      return svc.setGangStat(gangId, statId, value);
    },
    getPlayerStat(steamId: string, statId: string): StatValue {
      if (!isSteamId(steamId) || !isStatId(statId)) return null;
      return publicValue(svc.playerStat(steamId, statId));
    },
    setPlayerStat(steamId: string, statId: string, value: StatValue): boolean {
      if (!ready() || !isSteamId(steamId) || !writable("player", statId, value)) return false;
      return svc.setPlayerStat(steamId, statId, value);
    },

    getBalance(steamId: string, excludeGang: boolean): number {
      if (!ready() || !isSteamId(steamId)) return 0;
      return eco.getBalance(steamId, excludeGang === true);
    },
    getGangBalance(gangId: number): number {
      if (!ready() || !isGangId(gangId)) return 0;
      return eco.getGangBalance(gangId);
    },
    tryPurchase(steamId: string, cost: number, reason: string, excludeGang: boolean): number {
      if (!ready() || !isSteamId(steamId) || !isText(reason)) return -1;
      return eco.tryPurchase(steamId, cost, reason, excludeGang === true);
    },
    grantPlayer(steamId: string, amount: number, reason: string): number {
      if (!ready() || !isSteamId(steamId) || !isText(reason)) return -1;
      return eco.grantPlayer(steamId, amount, reason);
    },
    grantGang(gangId: number, amount: number, reason: string): number {
      if (!ready() || !isGangId(gangId) || !isText(reason)) return -1;
      return eco.grantGang(gangId, amount, reason);
    },

    registerPerk(provider: string, spec: PerkSpec): boolean {
      return perks.register(provider, spec);
    },
    listPerks: () => perks.list(),
    getPerkLevel(gangId: number, perkId: string): number {
      if (!ready() || !isGangId(gangId) || typeof perkId !== "string") return 0;
      return perks.level(gangId, perkId);
    },
    purchasePerk(steamId: string, perkId: string): PurchaseResult {
      if (!ready()) return { ok: false, reason: "not_ready" };
      if (!isSteamId(steamId)) return { ok: false, reason: "not_in_gang" };
      if (typeof perkId !== "string") return { ok: false, reason: "unknown_perk" };
      return perks.purchase(steamId, perkId);
    },

    sendGangChat(gangId: number, message: string): void {
      if (!ready() || !isGangId(gangId) || typeof message !== "string" || !svc.getGang(gangId)) return;
      d.sendGangChat(gangId, message);
    },
  };
}
