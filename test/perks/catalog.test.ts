import { describe, it, expect } from "vitest";
import { harness, S } from "../support/harness";
import { capacityCostFor, validSpec, MOTD_DEFAULT, GANGCHAT_COST } from "../../src/perks/catalog";
import { CAPACITY_STAT, CHAT_STAT, MOTD_STAT } from "../../src/store/stats";
import { Perm } from "../../src/domain/perm";

async function setup(running: (p: string) => boolean = () => true) {
  const h = await harness({ running });
  await h.connect(S.owner, "O");
  await h.connect(S.bob, "B");
  const g = h.gangs.svc.createGang("G", S.owner)!;
  h.gangs.svc.addMember(g.gangId, S.bob, 100);
  h.events.length = 0;
  return { h, perks: h.gangs.perks, gangId: g.gangId };
}

describe("capacityCostFor", () => {
  it("matches the upstream curve", () => {
    expect(capacityCostFor(2)).toBe(Math.ceil((200 + 4.9 * 16) / 500) * 100);
    expect(capacityCostFor(5)).toBe(Math.ceil((500 + 4.9 * 625) / 500) * 100);
    expect(capacityCostFor(15)).toBe(Math.ceil((1500 + 4.9 * 50625) / 500) * 100);
  });
});

describe("native perks", () => {
  it("lists the three natives with provider 'native' and their max levels", async () => {
    const { perks } = await setup();
    expect(perks.list()).toEqual([
      { id: CAPACITY_STAT, name: "Capacity", description: expect.any(String), provider: "native", maxLevel: 14 },
      { id: CHAT_STAT, name: "Gang Chat", description: expect.any(String), provider: "native", maxLevel: 1 },
      { id: MOTD_STAT, name: "MOTD", description: expect.any(String), provider: "native", maxLevel: 1 },
    ]);
  });

  it("capacity defaults to 1, increments per purchase and maxes at 15", async () => {
    const { h, perks, gangId } = await setup();
    expect(perks.capacity(gangId)).toBe(1);
    expect(perks.nextCost(gangId, CAPACITY_STAT)).toBe(capacityCostFor(2));
    h.gangs.eco.grantGang(gangId, 10_000_000, "seed");
    const r = perks.purchase(S.owner, CAPACITY_STAT);
    expect(r).toEqual({ ok: true, reason: "ok", cost: capacityCostFor(2), level: 1 });
    expect(perks.capacity(gangId)).toBe(2);
    h.gangs.svc.setGangStat(gangId, CAPACITY_STAT, 15);
    expect(perks.nextCost(gangId, CAPACITY_STAT)).toBeNull();
    expect(perks.purchase(S.owner, CAPACITY_STAT)).toEqual({ ok: false, reason: "max_level" });
  });

  it("gang chat and MOTD are one-shot purchases", async () => {
    const { h, perks, gangId } = await setup();
    h.gangs.eco.grantPlayer(S.owner, 20_000, "seed");
    expect(perks.purchase(S.owner, CHAT_STAT)).toEqual({ ok: true, reason: "ok", cost: GANGCHAT_COST, level: 1 });
    expect(perks.hasGangChat(gangId)).toBe(true);
    expect(perks.purchase(S.owner, CHAT_STAT).reason).toBe("max_level");
    expect(perks.purchase(S.owner, MOTD_STAT).ok).toBe(true);
    expect(perks.motd(gangId)).toBe(MOTD_DEFAULT);
    expect(perks.level(gangId, MOTD_STAT)).toBe(1);
  });

  it("purchase failure reasons", async () => {
    const { h, perks } = await setup();
    expect(perks.purchase(S.owner, "nope")).toEqual({ ok: false, reason: "unknown_perk" });
    expect(perks.purchase(S.dave, CHAT_STAT)).toEqual({ ok: false, reason: "not_in_gang" });
    h.gangs.svc.setRankPermission(1, 100, Perm.PURCHASE_PERKS, false);
    expect(perks.purchase(S.bob, CHAT_STAT)).toEqual({ ok: false, reason: "no_permission" });
    expect(perks.purchase(S.owner, CHAT_STAT)).toEqual({ ok: false, reason: "insufficient_funds", cost: GANGCHAT_COST });
    expect(h.eventsNamed("OnPerkPurchased")).toEqual([]);
  });
});

describe("external perks", () => {
  it("validates specs", () => {
    expect(validSpec({ id: "smoke", name: "Smoke", description: "", costs: [100, 200] })).toBe(true);
    expect(validSpec({ id: "icon", name: "Icon", description: "d", command: "sm_wardenicon" })).toBe(true);
    expect(validSpec({ id: "both", name: "B", description: "", costs: [1], command: "sm_x" })).toBe(false);
    expect(validSpec({ id: "neither", name: "N", description: "" })).toBe(false);
    expect(validSpec({ id: "bad id!", name: "N", description: "", costs: [1] })).toBe(false);
    expect(validSpec({ id: "neg", name: "N", description: "", costs: [-1] })).toBe(false);
    expect(validSpec({ id: "frac", name: "N", description: "", costs: [1.5] })).toBe(false);
    expect(validSpec({ id: "empty", name: "N", description: "", costs: [] })).toBe(false);
    expect(validSpec({ id: "inj", name: "N", description: "", command: "sm_x; quit" })).toBe(false);
    expect(validSpec({ id: "noname", name: " ", description: "", costs: [1] })).toBe(false);
  });

  it("registers levelled perks stored in perk:<id>, owned per provider", async () => {
    const { h, perks, gangId } = await setup();
    expect(perks.register("smokes", { id: "smoke", name: "Smoke", description: "Coloured smoke", costs: [100, 300] })).toBe(true);
    expect(perks.register("other", { id: "smoke", name: "X", description: "", costs: [1] })).toBe(false);
    expect(perks.register("smokes", { id: CHAT_STAT, name: "X", description: "", costs: [1] })).toBe(false);
    expect(perks.register("native", { id: "n", name: "X", description: "", costs: [1] })).toBe(false);
    expect(perks.register("smokes", { id: "smoke", name: "Smoke v2", description: "", costs: [100, 300, 900] })).toBe(true);
    expect(perks.list().at(-1)).toEqual({ id: "smoke", name: "Smoke v2", description: "", provider: "smokes", maxLevel: 3 });

    h.gangs.eco.grantPlayer(S.owner, 1000, "seed");
    expect(perks.purchase(S.owner, "smoke")).toEqual({ ok: true, reason: "ok", cost: 100, level: 1 });
    expect(perks.purchase(S.owner, "smoke")).toEqual({ ok: true, reason: "ok", cost: 300, level: 2 });
    expect(h.gangs.svc.gangStat(gangId, "perk:smoke")).toBe(2);
    expect(perks.level(gangId, "smoke")).toBe(2);
    expect(h.eventsNamed("OnPerkPurchased")).toEqual([
      { gangId, steamId: S.owner, perkId: "smoke", level: 1, cost: 100 },
      { gangId, steamId: S.owner, perkId: "smoke", level: 2, cost: 300 },
    ]);
    expect(perks.purchase(S.owner, "smoke")).toEqual({ ok: false, reason: "insufficient_funds", cost: 900 });
  });

  it("custom perks list their command and are not purchasable through Gangs", async () => {
    const { perks } = await setup();
    perks.register("warden", { id: "icon", name: "Warden Icon", description: "d", command: "sm_wardenicon" });
    expect(perks.list().at(-1)).toEqual({ id: "icon", name: "Warden Icon", description: "d", provider: "warden", command: "sm_wardenicon" });
    expect(perks.purchase(S.owner, "icon")).toEqual({ ok: false, reason: "unknown_perk" });
  });

  it("only lists perks whose provider is running", async () => {
    let running = true;
    const { perks } = await setup((p) => p !== "smokes" || running);
    perks.register("smokes", { id: "smoke", name: "Smoke", description: "", costs: [1] });
    expect(perks.list().map((p) => p.id)).toContain("smoke");
    running = false;
    expect(perks.list().map((p) => p.id)).not.toContain("smoke");
    expect(perks.purchase(S.owner, "smoke").reason).toBe("unknown_perk");
    running = true;
    expect(perks.list().map((p) => p.id)).toContain("smoke");
  });
});
