import { describe, it, expect } from "vitest";
import { harness, isWireClean, S } from "../support/harness";
import type { GangsApi } from "../../api";
import { isSteamId } from "../../src/api/impl";
import { Perm } from "../../src/domain/perm";
import { BALANCE_STAT, CAPACITY_STAT, DOOR_POLICY_STAT, INVITATION_STAT } from "../../src/store/stats";

/** Every contract method, so the suite notices if the impl and api.d.ts drift apart. */
const METHODS: Array<keyof GangsApi> = [
  "isReady", "getGang", "getGangOf", "getMember", "getMembers", "getRanks", "hasPermission",
  "getGangStat", "setGangStat", "getPlayerStat", "setPlayerStat",
  "getBalance", "getGangBalance", "tryPurchase", "grantPlayer", "grantGang",
  "registerPerk", "listPerks", "getPerkLevel", "purchasePerk", "sendGangChat",
];

async function setup() {
  const h = await harness();
  await h.connect(S.owner, "Owner");
  await h.connect(S.bob, "Bob");
  const g = h.gangs.svc.createGang("Wolves", S.owner)!;
  h.gangs.svc.addMember(g.gangId, S.bob, 100);
  h.events.length = 0;
  return { h, api: h.gangs.api, gangId: g.gangId };
}

describe("@edgegamers/gangs — shape", () => {
  it("implements exactly the contract methods, all synchronous", async () => {
    const { api } = await setup();
    expect(Object.keys(api).sort()).toEqual([...METHODS].sort());
    for (const m of METHODS) expect(api[m].constructor.name).toBe("Function"); // not AsyncFunction
  });

  it("isSteamId accepts only canonical nonzero u64 decimals", () => {
    expect(isSteamId(S.owner)).toBe(true);
    expect(isSteamId("18446744073709551615")).toBe(true);
    for (const bad of ["0", "", "0123", "-1", "1.0", "18446744073709551616", "abc", " 1"]) expect(isSteamId(bad)).toBe(false);
  });
});

describe("@edgegamers/gangs — before ready", () => {
  it("reads empty/null/0 and writes false until OnReady", async () => {
    const h = await harness({ noFlush: true });
    const api = h.gangs.api;
    expect(api.isReady()).toBe(false);
    expect(api.getGang(1)).toBeNull();
    expect(api.getGangOf(S.owner)).toBeNull();
    expect(api.getMembers(1)).toEqual([]);
    expect(api.getRanks(1)).toEqual([]);
    expect(api.getGangStat(1, "x")).toBeNull();
    expect(api.getBalance(S.owner, false)).toBe(0);
    expect(api.setGangStat(1, "x", 1)).toBe(false);
    expect(api.setPlayerStat(S.owner, "x", 1)).toBe(false);
    expect(api.grantPlayer(S.owner, 5, "r")).toBe(-1);
    expect(api.grantGang(1, 5, "r")).toBe(-1);
    expect(api.tryPurchase(S.owner, 5, "r", false)).toBe(-1);
    expect(api.getPerkLevel(1, CAPACITY_STAT)).toBe(0);
    expect(api.purchasePerk(S.owner, CAPACITY_STAT)).toEqual({ ok: false, reason: "not_ready" });
    await h.gangs.svc.flush();
    expect(api.isReady()).toBe(true);
    expect(h.events).toEqual([["OnReady", { gangs: 0 }]]);
  });
});

describe("@edgegamers/gangs — reads", () => {
  it("returns plain, wire-clean copies", async () => {
    const { api, gangId } = await setup();
    expect(api.getGang(gangId)).toEqual({ id: gangId, name: "Wolves" });
    expect(api.getGangOf(S.bob)).toEqual({ id: gangId, name: "Wolves" });
    expect(api.getMember(S.bob)).toEqual({ steamId: S.bob, name: "Bob", gangId, rank: 100 });
    expect(api.getMember(S.dave)).toBeNull();
    expect(api.getMembers(gangId)).toEqual([
      { steamId: S.owner, name: "Owner", gangId, rank: 0 },
      { steamId: S.bob, name: "Bob", gangId, rank: 100 },
    ]);
    expect(api.getRanks(gangId).map((r) => r.rank)).toEqual([0, 10, 30, 50, 100]);
    for (const v of [api.getGang(gangId), api.getMembers(gangId), api.getRanks(gangId), api.listPerks()]) expect(isWireClean(v)).toBe(true);
    // mutating a returned value never touches the cache
    api.getMembers(gangId)[0].rank = 99;
    expect(api.getMember(S.owner)?.rank).toBe(0);
  });

  it("hasPermission checks every requested bit", async () => {
    const { api } = await setup();
    expect(api.hasPermission(S.owner, Perm.KICK_OTHERS | Perm.BANK_WITHDRAW)).toBe(true);
    expect(api.hasPermission(S.bob, Perm.BANK_DEPOSIT)).toBe(true);
    expect(api.hasPermission(S.bob, Perm.BANK_DEPOSIT | Perm.KICK_OTHERS)).toBe(false);
    expect(api.hasPermission(S.dave, 0)).toBe(false);
    expect(api.hasPermission("not-a-steamid", 0)).toBe(false);
  });

  it("rejects malformed ids without throwing", async () => {
    const { api } = await setup();
    expect(api.getGang(0)).toBeNull();
    expect(api.getGang(1.5)).toBeNull();
    expect(api.getGangOf("123abc")).toBeNull();
    expect(api.getMembers(-1)).toEqual([]);
  });
});

describe("@edgegamers/gangs — stats", () => {
  it("round-trips generic stats of every StatValue type, null clears", async () => {
    const { api, gangId } = await setup();
    for (const v of ["text", 42, 2.5, true, false]) {
      expect(api.setGangStat(gangId, "plugin:thing", v)).toBe(true);
      expect(api.getGangStat(gangId, "plugin:thing")).toBe(v);
      expect(api.setPlayerStat(S.bob, "plugin:thing", v)).toBe(true);
      expect(api.getPlayerStat(S.bob, "plugin:thing")).toBe(v);
    }
    expect(api.setGangStat(gangId, "plugin:thing", null)).toBe(true);
    expect(api.getGangStat(gangId, "plugin:thing")).toBeNull();
  });

  it("protects balances, type-checks native stats, exposes records as JSON", async () => {
    const { h, api, gangId } = await setup();
    expect(api.setGangStat(gangId, BALANCE_STAT, 1_000_000)).toBe(false);
    expect(api.setPlayerStat(S.bob, BALANCE_STAT, 5)).toBe(false);
    expect(api.setGangStat(gangId, DOOR_POLICY_STAT, "open")).toBe(false);
    expect(api.setGangStat(gangId, DOOR_POLICY_STAT, 2)).toBe(true);
    expect(api.setGangStat(gangId, INVITATION_STAT, "{}")).toBe(false);
    h.gangs.svc.createInvite(gangId, S.owner, S.dave, 9);
    const json = api.getGangStat(gangId, INVITATION_STAT);
    expect(typeof json).toBe("string");
    expect(JSON.parse(json as string)).toMatchObject({ InvitedSteams: S.dave });
  });

  it("refuses unknown gangs / unloaded players and non-finite numbers", async () => {
    const { api } = await setup();
    expect(api.setGangStat(999, "x", 1)).toBe(false);
    expect(api.setPlayerStat(S.dave, "x", 1)).toBe(false);
    expect(api.setGangStat(1, "x", Number.NaN)).toBe(false);
    expect(api.setGangStat(1, "", 1)).toBe(false);
  });
});

describe("@edgegamers/gangs — economy & events", () => {
  it("grants and purchases emit OnBalanceChanged with exact, clean payloads", async () => {
    const { h, api, gangId } = await setup();
    expect(api.grantPlayer(S.owner, 100, "reward")).toBe(100);
    expect(api.grantGang(gangId, 50, "deposit")).toBe(50);
    expect(api.getBalance(S.owner, false)).toBe(150);
    expect(api.getBalance(S.owner, true)).toBe(100);
    expect(api.getGangBalance(gangId)).toBe(50);
    expect(api.tryPurchase(S.owner, 70, "shop", false)).toBe(80);
    expect(api.tryPurchase(S.owner, 1000, "shop", false)).toBe(-1);
    const payloads = h.eventsNamed("OnBalanceChanged");
    expect(payloads).toEqual([
      { kind: "player", steamId: S.owner, balance: 100, delta: 100, reason: "reward" },
      { kind: "gang", gangId, balance: 50, delta: 50, reason: "deposit" },
      { kind: "gang", gangId, balance: 0, delta: -50, reason: "shop" },
      { kind: "player", steamId: S.owner, balance: 80, delta: -20, reason: "shop" },
    ]);
    for (const p of payloads) {
      expect(isWireClean(p)).toBe(true);
      // the optional side that does not apply is omitted, not undefined
      expect("gangId" in (p as object) && "steamId" in (p as object)).toBe(false);
    }
  });

  it("every emitted payload is wire-clean and matches its forward's fields", async () => {
    const { h, api, gangId } = await setup();
    api.grantGang(gangId, 100_000, "seed");
    api.purchasePerk(S.owner, CAPACITY_STAT);
    h.gangs.svc.setMemberRank(S.bob, 50);
    h.gangs.svc.renameGang(gangId, "Lions");
    h.gangs.svc.removeMember(S.bob, "leave");
    h.gangs.svc.disbandGang(gangId);
    const FIELDS: Record<string, string[]> = {
      OnGangCreated: ["gangId", "name"], OnGangDisbanded: ["gangId", "name"], OnGangRenamed: ["gangId", "name"],
      OnMemberJoined: ["gangId", "rank", "steamId"], OnMemberLeft: ["gangId", "reason", "steamId"],
      OnMemberRankChanged: ["gangId", "newRank", "oldRank", "steamId"],
      OnPerkPurchased: ["cost", "gangId", "level", "perkId", "steamId"],
    };
    expect(h.events.map(([e]) => e)).toEqual([
      "OnBalanceChanged", "OnBalanceChanged", "OnPerkPurchased", "OnMemberRankChanged", "OnGangRenamed",
      "OnMemberLeft", "OnMemberLeft", "OnGangDisbanded",
    ]);
    for (const [e, p] of h.events) {
      expect(isWireClean(p)).toBe(true);
      if (FIELDS[e]) expect(Object.keys(p as object).sort()).toEqual(FIELDS[e]);
    }
  });
});

describe("@edgegamers/gangs — perks & chat", () => {
  it("registerPerk / listPerks / getPerkLevel / purchasePerk", async () => {
    const { api, gangId } = await setup();
    expect(api.registerPerk("smokes", { id: "smoke", name: "Smoke", description: "d", costs: [10] })).toBe(true);
    expect(api.listPerks().map((p) => p.id)).toContain("smoke");
    expect(api.getPerkLevel(gangId, "smoke")).toBe(0);
    api.grantPlayer(S.owner, 10, "seed");
    expect(api.purchasePerk(S.owner, "smoke")).toEqual({ ok: true, reason: "ok", cost: 10, level: 1 });
    expect(api.getPerkLevel(gangId, "smoke")).toBe(1);
    expect(api.getGangStat(gangId, "perk:smoke")).toBe(1);
    expect(api.purchasePerk(S.owner, "smoke")).toEqual({ ok: false, reason: "max_level" });
    expect(api.purchasePerk("bogus", "smoke")).toEqual({ ok: false, reason: "not_in_gang" });
  });

  it("sendGangChat prints to online members only, with the gang prefix", async () => {
    const { h, api, gangId } = await setup();
    h.disconnect(S.bob);
    api.sendGangChat(gangId, "Raid at 9");
    expect(h.delivered).toEqual([[[S.owner], "[Wolves] Raid at 9"]]);
    api.sendGangChat(999, "nobody");
    expect(h.delivered).toHaveLength(1);
  });
});
