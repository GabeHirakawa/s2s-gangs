import { describe, it, expect } from "vitest";
import { harness, S } from "../support/harness";
import { Perm } from "../../src/domain/perm";

async function setup() {
  const h = await harness();
  await h.connect(S.owner, "O");
  await h.connect(S.bob, "B");
  const g = h.gangs.svc.createGang("G", S.owner)!;
  h.gangs.svc.addMember(g.gangId, S.bob, 100); // Member: no BANK_WITHDRAW
  h.events.length = 0;
  return { h, eco: h.gangs.eco, gangId: g.gangId };
}

describe("Economy", () => {
  it("wallet and bank start at 0; grants emit exact payloads", async () => {
    const { h, eco, gangId } = await setup();
    expect(eco.getBalance(S.bob, false)).toBe(0);
    expect(eco.grantPlayer(S.bob, 100, "test")).toBe(100);
    expect(eco.grantGang(gangId, 40, "seed")).toBe(40);
    expect(h.events).toEqual([
      ["OnBalanceChanged", { kind: "player", steamId: S.bob, balance: 100, delta: 100, reason: "test" }],
      ["OnBalanceChanged", { kind: "gang", gangId, balance: 40, delta: 40, reason: "seed" }],
    ]);
  });

  it("only BANK_WITHDRAW members see the gang bank in their balance", async () => {
    const { h, eco, gangId } = await setup();
    eco.grantGang(gangId, 500, "seed");
    eco.grantPlayer(S.bob, 10, "x");
    eco.grantPlayer(S.owner, 10, "x");
    expect(eco.getBalance(S.bob, false)).toBe(10);
    expect(eco.getBalance(S.owner, false)).toBe(510);
    expect(eco.getBalance(S.owner, true)).toBe(10);
    h.gangs.svc.setRankPermission(gangId, 100, Perm.BANK_WITHDRAW, true);
    expect(eco.getBalance(S.bob, false)).toBe(510);
  });

  it("tryPurchase draws bank-first, returns the remainder, or -1 without charging", async () => {
    const { h, eco, gangId } = await setup();
    eco.grantGang(gangId, 30, "seed");
    eco.grantPlayer(S.owner, 50, "seed");
    h.events.length = 0;
    expect(eco.tryPurchase(S.owner, 100, "too much", false)).toBe(-1);
    expect(h.events).toEqual([]);
    expect(eco.tryPurchase(S.owner, 45, "thing", false)).toBe(35);
    expect(eco.getGangBalance(gangId)).toBe(0);
    expect(eco.wallet(S.owner)).toBe(35);
    expect(h.events).toEqual([
      ["OnBalanceChanged", { kind: "gang", gangId, balance: 0, delta: -30, reason: "thing" }],
      ["OnBalanceChanged", { kind: "player", steamId: S.owner, balance: 35, delta: -15, reason: "thing" }],
    ]);
    expect(eco.tryPurchase(S.owner, 10, "wallet only", true)).toBe(25);
  });

  it("clamps at zero and rejects invalid amounts / unknown targets with -1", async () => {
    const { eco, gangId } = await setup();
    eco.grantPlayer(S.bob, 5, "x");
    expect(eco.grantPlayer(S.bob, -50, "take")).toBe(0);
    expect(eco.grantPlayer(S.bob, 1.5, "x")).toBe(-1);
    expect(eco.grantPlayer(S.dave, 5, "x")).toBe(-1);   // not loaded
    expect(eco.grantGang(999, 5, "x")).toBe(-1);
    expect(eco.tryPurchase(S.bob, -1, "x", false)).toBe(-1);
    expect(eco.getGangBalance(gangId)).toBe(0);
  });

  it("balances persist", async () => {
    const { h, eco } = await setup();
    eco.grantPlayer(S.bob, 77, "x");
    await h.gangs.svc.flush();
    expect(await h.db.query("SELECT gang_native_balance AS b FROM gang_player_stats_gang_native_balance")).toEqual([{ b: 77 }]);
  });
});
