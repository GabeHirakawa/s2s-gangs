import type { PerkInfo, PerkSpec, PurchaseResult } from "../../api";
import type { GangService } from "../service/gang-service";
import type { Economy } from "../eco/economy";
import { Perm } from "../domain/perm";
import { CAPACITY_STAT, CHAT_STAT, MOTD_STAT } from "../store/stats";

export const NATIVE_PROVIDER = "native";
export const MAX_CAPACITY = 15;
export const GANGCHAT_COST = 5000; // upstream cost not published in the source we ported from; chosen default
export const MOTD_COST = 7500;
export const MOTD_DEFAULT = "Use !gang_motd <message> to set the MOTD.";

/** Upstream capacity cost curve: ceil((100·s + 4.9·s⁴)/500)·100 for growing to size `s`. */
export function capacityCostFor(size: number): number {
  return Math.ceil((100 * size + 4.9 * size ** 4) / 500) * 100;
}

/** The stat holding an external levelled perk's level. */
export const perkStatId = (perkId: string): string => `perk:${perkId}`;

/** A perk as Gangs handles it internally. */
export interface PerkEntry {
  id: string;
  name: string;
  description: string;
  provider: string;
  /** Levelled perks: max level, current level, the price of the next level, and how to apply one. */
  levelled: null | {
    maxLevel: number;
    level(gangId: number): number;
    costOf(level: number): number;
    apply(gangId: number, newLevel: number): void;
  };
  /** Custom perks: the command run as the player when chosen. */
  command: string | null;
}

const PERK_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const COMMAND = /^[A-Za-z0-9_]{1,64}( [^;\r\n]{0,120})?$/;
const MAX_LEVELS = 100;

/** Validate an external `PerkSpec` (it arrives over the wire from another plugin). */
export function validSpec(spec: PerkSpec): boolean {
  if (!spec || typeof spec !== "object") return false;
  if (typeof spec.id !== "string" || !PERK_ID.test(spec.id)) return false;
  if (typeof spec.name !== "string" || spec.name.trim().length === 0 || spec.name.length > 64) return false;
  if (typeof spec.description !== "string" || spec.description.length > 255) return false;
  const hasCosts = spec.costs !== undefined, hasCommand = spec.command !== undefined;
  if (hasCosts === hasCommand) return false; // exactly one of the two
  if (hasCosts) {
    const c = spec.costs!;
    if (!Array.isArray(c) || c.length === 0 || c.length > MAX_LEVELS) return false;
    if (!c.every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  } else if (typeof spec.command !== "string" || !COMMAND.test(spec.command)) return false;
  return true;
}

/**
 * The perk catalog: Gangs' three native perks (Capacity, Gang Chat, MOTD) plus perks registered by
 * other plugins through `registerPerk`. External perks are visible only while their provider runs.
 */
export class PerkCatalog {
  private readonly natives: PerkEntry[];
  private readonly external = new Map<string, PerkEntry>();

  constructor(
    private readonly svc: GangService,
    private readonly eco: Economy,
    /** Is the plugin with this id currently running? (Plugins.list() at runtime.) */
    private readonly providerRunning: (provider: string) => boolean = () => true,
  ) {
    this.natives = [
      {
        id: CAPACITY_STAT, name: "Capacity", description: "Increase your gang's member capacity.",
        provider: NATIVE_PROVIDER, command: null,
        levelled: {
          maxLevel: MAX_CAPACITY - 1,
          level: (g) => this.capacity(g) - 1,
          costOf: (level) => capacityCostFor(level + 2),
          apply: (g, newLevel) => { this.svc.setGangStat(g, CAPACITY_STAT, newLevel + 1); },
        },
      },
      {
        id: CHAT_STAT, name: "Gang Chat", description: "Talk to your gang with .message",
        provider: NATIVE_PROVIDER, command: null,
        levelled: {
          maxLevel: 1,
          level: (g) => (this.svc.gangStat(g, CHAT_STAT) === 1 ? 1 : 0),
          costOf: () => GANGCHAT_COST,
          apply: (g) => { this.svc.setGangStat(g, CHAT_STAT, 1); },
        },
      },
      {
        id: MOTD_STAT, name: "MOTD", description: "A message of the day shown in your gang menu.",
        provider: NATIVE_PROVIDER, command: null,
        levelled: {
          maxLevel: 1,
          level: (g) => (typeof this.svc.gangStat(g, MOTD_STAT) === "string" ? 1 : 0),
          costOf: () => MOTD_COST,
          apply: (g) => { this.svc.setGangStat(g, MOTD_STAT, MOTD_DEFAULT); },
        },
      },
    ];
  }

  /** Current member capacity (>= 1). */
  capacity(gangId: number): number {
    const c = this.svc.gangStat(gangId, CAPACITY_STAT);
    return typeof c === "number" && c >= 1 ? Math.floor(c) : 1;
  }

  hasGangChat(gangId: number): boolean { return this.svc.gangStat(gangId, CHAT_STAT) === 1; }

  motd(gangId: number): string | null {
    const v = this.svc.gangStat(gangId, MOTD_STAT);
    return typeof v === "string" ? v : null;
  }

  /** Register (or, from the same provider, replace) an external perk. */
  register(provider: string, spec: PerkSpec): boolean {
    if (typeof provider !== "string" || !PERK_ID.test(provider) || provider === NATIVE_PROVIDER) return false;
    if (!validSpec(spec)) return false;
    if (this.natives.some((p) => p.id === spec.id)) return false;
    const existing = this.external.get(spec.id);
    if (existing && existing.provider !== provider) return false;
    const statId = perkStatId(spec.id);
    const costs = spec.costs ? [...spec.costs] : null;
    this.external.set(spec.id, {
      id: spec.id, name: spec.name.trim(), description: spec.description, provider,
      command: spec.command ?? null,
      levelled: costs === null ? null : {
        maxLevel: costs.length,
        level: (g) => {
          const v = this.svc.gangStat(g, statId);
          return typeof v === "number" && v > 0 ? Math.min(Math.floor(v), costs.length) : 0;
        },
        costOf: (level) => costs[level] ?? 0,
        apply: (g, newLevel) => { this.svc.setGangStat(g, statId, newLevel); },
      },
    });
    return true;
  }

  /** Every currently visible perk: natives, then external perks whose provider is running. */
  all(): PerkEntry[] {
    const out = [...this.natives];
    for (const p of this.external.values()) if (this.providerRunning(p.provider)) out.push(p);
    return out;
  }

  get(perkId: string): PerkEntry | null {
    return this.all().find((p) => p.id === perkId) ?? null;
  }

  list(): PerkInfo[] {
    return this.all().map((p) => {
      const info: PerkInfo = { id: p.id, name: p.name, description: p.description, provider: p.provider };
      if (p.levelled) info.maxLevel = p.levelled.maxLevel;
      if (p.command !== null) info.command = p.command;
      return info;
    });
  }

  /** Level of a levelled perk for a gang (0 = not owned / unknown). */
  level(gangId: number, perkId: string): number {
    const p = this.get(perkId);
    if (!p || !p.levelled || !this.svc.getGang(gangId)) return 0;
    return p.levelled.level(gangId);
  }

  /** Price of the next level, or null when maxed / not levelled / unknown. */
  nextCost(gangId: number, perkId: string): number | null {
    const p = this.get(perkId);
    if (!p || !p.levelled) return null;
    const level = p.levelled.level(gangId);
    return level >= p.levelled.maxLevel ? null : p.levelled.costOf(level);
  }

  /** Buy the next level of a levelled perk for `steam`'s gang (bank first). */
  purchase(steam: string, perkId: string): PurchaseResult {
    if (!this.svc.isReady()) return { ok: false, reason: "not_ready" };
    const perk = this.get(perkId);
    if (!perk || !perk.levelled) return { ok: false, reason: "unknown_perk" };
    const player = this.svc.getPlayer(steam);
    if (!player || player.gangId === null) return { ok: false, reason: "not_in_gang" };
    const gangId = player.gangId;
    if (!this.svc.hasPermission(steam, Perm.PURCHASE_PERKS)) return { ok: false, reason: "no_permission" };
    const level = perk.levelled.level(gangId);
    if (level >= perk.levelled.maxLevel) return { ok: false, reason: "max_level" };
    const cost = perk.levelled.costOf(level);
    if (this.eco.tryPurchase(steam, cost, `perk:${perk.id}`, false) < 0)
      return { ok: false, reason: "insufficient_funds", cost };
    const newLevel = level + 1;
    perk.levelled.apply(gangId, newLevel);
    this.svc.emit("OnPerkPurchased", { gangId, steamId: steam, perkId: perk.id, level: newLevel, cost });
    return { ok: true, reason: "ok", cost, level: newLevel };
  }
}
