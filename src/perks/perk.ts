import type { StatDescriptor } from "../db/instance.repo";

export interface PerkStats {
  getForGang<T>(gangId: number, statId: string): Promise<T | null>;
  setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean>;
}

export interface Perk {
  id: string;
  name: string;
  description: string;
  descriptor: StatDescriptor;
  /** Cost to purchase the next level for this gang, or null if not currently purchasable. */
  getCost(stats: PerkStats, gangId: number): Promise<number | null>;
  /** Apply the purchase (increment level / set flag / seed default). */
  onPurchase(stats: PerkStats, gangId: number): Promise<void>;
}

const CAPACITY_ID = "gang_native_capacity";
const CHAT_ID = "gang_native_chat";
const MOTD_ID = "gang_native_motd";
const MAX_CAPACITY = 15;
const GANGCHAT_COST = 5000; // upstream cost not published in the source we ported from; chosen default
const MOTD_COST = 7500;
const MOTD_DEFAULT = "Use !gang_motd <message> to set the MOTD.";

/** Upstream capacity cost curve: ceil((100·s + 4.9·s⁴)/500)·100. */
export function capacityCostFor(size: number): number {
  return Math.ceil((100 * size + 4.9 * size ** 4) / 500) * 100;
}

async function capacityOf(stats: PerkStats, gangId: number): Promise<number> {
  const c = (await stats.getForGang<number>(gangId, CAPACITY_ID)) ?? 1;
  return c < 1 ? 1 : c;
}

export const CAPACITY_PERK: Perk = {
  id: CAPACITY_ID, name: "Capacity", description: "Increase your gang's member capacity.",
  descriptor: { id: CAPACITY_ID, scope: "gang", kind: "scalar", column: "INT" },
  async getCost(stats, gangId) {
    const c = await capacityOf(stats, gangId);
    return c >= MAX_CAPACITY ? null : capacityCostFor(c + 1);
  },
  async onPurchase(stats, gangId) {
    const c = await capacityOf(stats, gangId);
    if (c < MAX_CAPACITY) await stats.setForGang(gangId, CAPACITY_ID, c + 1);
  },
};

export const GANGCHAT_PERK: Perk = {
  id: CHAT_ID, name: "Gang Chat", description: "Talk to your gang with .message",
  descriptor: { id: CHAT_ID, scope: "gang", kind: "scalar", column: "INT" },
  async getCost(stats, gangId) {
    return (await stats.getForGang<number>(gangId, CHAT_ID)) === 1 ? null : GANGCHAT_COST;
  },
  async onPurchase(stats, gangId) { await stats.setForGang(gangId, CHAT_ID, 1); },
};

export const MOTD_PERK: Perk = {
  id: MOTD_ID, name: "MOTD", description: "A message of the day shown in your gang menu.",
  descriptor: { id: MOTD_ID, scope: "gang", kind: "scalar", column: "VARCHAR(255)" },
  async getCost(stats, gangId) {
    const motd = await stats.getForGang<string>(gangId, MOTD_ID);
    return motd === null || motd === undefined ? MOTD_COST : null;
  },
  async onPurchase(stats, gangId) {
    const motd = await stats.getForGang<string>(gangId, MOTD_ID);
    if (motd === null || motd === undefined) await stats.setForGang(gangId, MOTD_ID, MOTD_DEFAULT);
  },
};

export const ALL_PERKS: Perk[] = [CAPACITY_PERK, GANGCHAT_PERK, MOTD_PERK];
