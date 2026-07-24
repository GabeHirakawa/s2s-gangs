import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { StatStore } from "../../src/db/instance.repo";
import { StatManager } from "../../src/managers/stat-manager";
import { capacityCostFor, CAPACITY_PERK, GANGCHAT_PERK, MOTD_PERK, ALL_PERKS } from "../../src/perks/perk";

function stats() {
  const db = makeTestDb();
  const m = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  for (const p of ALL_PERKS) m.register(p.descriptor);
  return m;
}

describe("capacityCostFor", () => {
  it("matches the upstream formula", () => {
    expect(capacityCostFor(2)).toBe(100);
    expect(capacityCostFor(15)).toBe(50000);
  });
});

describe("CAPACITY_PERK", () => {
  it("starts at 1, increments, and maxes out at 15 (getCost null)", async () => {
    const s = stats();
    expect(await CAPACITY_PERK.getCost(s, 1)).toBe(capacityCostFor(2));
    await CAPACITY_PERK.onPurchase(s, 1);
    expect(await s.getForGang<number>(1, "gang_native_capacity")).toBe(2);
    await s.setForGang(1, "gang_native_capacity", 15);
    expect(await CAPACITY_PERK.getCost(s, 1)).toBeNull();
  });
});

describe("GANGCHAT_PERK / MOTD_PERK", () => {
  it("gang chat is a one-time purchase", async () => {
    const s = stats();
    expect(await GANGCHAT_PERK.getCost(s, 1)).toBeGreaterThan(0);
    await GANGCHAT_PERK.onPurchase(s, 1);
    expect(await s.getForGang<number>(1, "gang_native_chat")).toBe(1);
    expect(await GANGCHAT_PERK.getCost(s, 1)).toBeNull();
  });
  it("motd costs 7500 once then becomes unpurchasable", async () => {
    const s = stats();
    expect(await MOTD_PERK.getCost(s, 1)).toBe(7500);
    await MOTD_PERK.onPurchase(s, 1);
    expect(await MOTD_PERK.getCost(s, 1)).toBeNull();
  });
});
