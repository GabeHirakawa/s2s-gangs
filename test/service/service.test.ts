import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { harness, S } from "../support/harness";
import type { Db } from "../../src/store/db";
import { DeleteStrat } from "../../src/domain/types";
import { Perm } from "../../src/domain/perm";
import { BALANCE_STAT, PENDING_STAT } from "../../src/store/stats";

describe("GangService — readiness", () => {
  it("is not ready until the boot load finishes; reads are empty and writes refused meanwhile", async () => {
    const h = await harness({ noFlush: true });
    const { svc } = h.gangs;
    expect(svc.isReady()).toBe(false);
    expect(svc.allGangs()).toEqual([]);
    expect(svc.getPlayer(S.owner)).toBeNull();
    expect(svc.createGang("G", S.owner)).toBeNull();
    expect(svc.setGangStat(1, "x", 1)).toBe(false);
    expect(h.eventsNamed("OnReady")).toEqual([]);
    await svc.flush();
    expect(svc.isReady()).toBe(true);
    expect(h.eventsNamed("OnReady")).toEqual([{ gangs: 0 }]);
  });

  it("stays not-ready (and logs) when the database cannot be opened", async () => {
    const h = await harness({ db: { query: () => Promise.reject(new Error("down")), execute: () => Promise.reject(new Error("down")) } });
    expect(h.gangs.svc.isReady()).toBe(false);
    expect(h.logs.join("\n")).toMatch(/boot.*down/);
    expect(h.eventsNamed("OnReady")).toEqual([]);
  });
});

describe("GangService — players", () => {
  it("creates a row for a new player on connect and caches it", async () => {
    const h = await harness();
    expect(h.gangs.svc.isLoaded(S.bob)).toBe(false);
    await h.connect(S.bob, "Bob");
    expect(h.gangs.svc.getPlayer(S.bob)).toEqual({ steam: S.bob, name: "Bob", gangId: null, gangRank: null });
    expect(await h.db.query("SELECT CAST(Steam AS TEXT) AS s, Name FROM gang_players")).toEqual([{ s: S.bob, Name: "Bob" }]);
  });

  it("refreshes a cached player's name on reconnect and persists it", async () => {
    const h = await harness();
    await h.connect(S.owner, "Old");
    h.gangs.svc.createGang("G", S.owner);
    await h.connect(S.owner, "New");
    expect(h.gangs.svc.getPlayer(S.owner)?.name).toBe("New");
    expect(await h.db.query("SELECT Name FROM gang_players")).toEqual([{ Name: "New" }]);
  });

  it("evicts gangless players on disconnect but keeps members cached", async () => {
    const h = await harness();
    await h.connect(S.owner, "O");
    await h.connect(S.bob, "Bob");
    h.gangs.svc.createGang("G", S.owner);
    h.disconnect(S.owner);
    h.disconnect(S.bob);
    expect(h.gangs.svc.getPlayer(S.owner)).not.toBeNull();
    expect(h.gangs.svc.getPlayer(S.bob)).toBeNull();
  });

  it("a reconnect load observes writes made before the disconnect (single ordered queue)", async () => {
    const h = await harness();
    await h.connect(S.bob, "Bob");
    h.gangs.svc.setPlayerStat(S.bob, BALANCE_STAT, 123);
    h.disconnect(S.bob);           // evicted while the write may still be queued
    h.gangs.svc.playerConnected(S.bob, "Bob");
    await h.gangs.svc.flush();
    expect(h.gangs.svc.playerStat(S.bob, BALANCE_STAT)).toBe(123);
  });

  it("drops a load whose player already left", async () => {
    const h = await harness();
    h.gangs.svc.playerConnected(S.carol, "C");
    h.gangs.svc.playerDisconnected(S.carol);
    await h.gangs.svc.flush();
    expect(h.gangs.svc.getPlayer(S.carol)).toBeNull();
  });
});

describe("GangService — gangs & persistence", () => {
  it("creates a gang synchronously with default ranks and persists it in order", async () => {
    const h = await harness();
    await h.connect(S.owner, "O");
    const gang = h.gangs.svc.createGang("  Wolves ", S.owner);
    expect(gang).toEqual({ gangId: 1, name: "Wolves" });
    expect(h.gangs.svc.getPlayer(S.owner)).toMatchObject({ gangId: 1, gangRank: 0 });
    expect(h.gangs.svc.ranksOf(1).map((r) => r.rank)).toEqual([0, 10, 30, 50, 100]);
    expect(h.events.map(([e]) => e)).toEqual(["OnReady", "OnGangCreated", "OnMemberJoined"]);
    expect(h.eventsNamed("OnGangCreated")).toEqual([{ gangId: 1, name: "Wolves" }]);
    expect(h.eventsNamed("OnMemberJoined")).toEqual([{ gangId: 1, steamId: S.owner, rank: 0 }]);
    await h.gangs.svc.flush();
    expect(await h.db.query("SELECT GangId, Name FROM gang_gangs")).toEqual([{ GangId: 1, Name: "Wolves" }]);
  });

  it("allocates max(id)+1 (explicit ids) and refuses duplicate names / members", async () => {
    const h = await harness();
    await h.connect(S.owner, "O");
    await h.connect(S.bob, "B");
    await h.connect(S.carol, "C");
    expect(h.gangs.svc.createGang("A", S.owner)?.gangId).toBe(1);
    expect(h.gangs.svc.createGang("a", S.bob)).toBeNull();          // name taken (case-insensitive)
    expect(h.gangs.svc.createGang("B", S.owner)).toBeNull();        // already in a gang
    expect(h.gangs.svc.createGang("B", S.bob)?.gangId).toBe(2);
    h.gangs.svc.disbandGang(2);
    expect(h.gangs.svc.createGang("C", S.carol)?.gangId).toBe(2);
    expect(h.gangs.svc.createGang("X", S.dave)).toBeNull();         // not loaded
  });

  it("a fresh service on the same database rebuilds the same cache", async () => {
    const db: Db = makeTestDb();
    const a = await harness({ db });
    await a.connect(S.owner, "O");
    await a.connect(S.bob, "Bob");
    const g = a.gangs.svc.createGang("Wolves", S.owner)!;
    a.gangs.svc.addMember(g.gangId, S.bob, 100);
    a.gangs.svc.setGangStat(g.gangId, "perk:x", 3);
    a.gangs.svc.setPlayerStat(S.bob, "kills", 9);
    a.gangs.svc.createRank(g.gangId, "Recruit", 200, Perm.NONE);
    await a.gangs.svc.flush();

    const b = await harness({ db });
    const svc = b.gangs.svc;
    expect(svc.allGangs()).toEqual([{ gangId: 1, name: "Wolves" }]);
    expect(svc.membersOf(1).map((m) => [m.steam, m.gangRank])).toEqual([[S.owner, 0], [S.bob, 100]]);
    expect(svc.ranksOf(1).map((r) => r.rank)).toEqual([0, 10, 30, 50, 100, 200]);
    expect(svc.gangStat(1, "perk:x")).toBe(3);
    expect(svc.playerStat(S.bob, "kills")).toBe(9);
    expect(b.eventsNamed("OnReady")).toEqual([{ gangs: 1 }]);
  });

  it("disband clears members, ranks, stats and pending invites, and emits per member", async () => {
    const h = await harness();
    await h.connect(S.owner, "O");
    await h.connect(S.bob, "B");
    await h.connect(S.carol, "C");
    const g = h.gangs.svc.createGang("G", S.owner)!;
    h.gangs.svc.addMember(g.gangId, S.bob, 100);
    h.gangs.svc.setGangStat(g.gangId, BALANCE_STAT, 50);
    h.gangs.svc.createInvite(g.gangId, S.owner, S.carol, 1);
    expect(h.gangs.svc.pendingInvites(S.carol)).toEqual([g.gangId]);
    h.events.length = 0;
    expect(h.gangs.svc.disbandGang(g.gangId)).toBe(true);
    expect(h.gangs.svc.getGang(g.gangId)).toBeNull();
    expect(h.gangs.svc.getPlayer(S.bob)?.gangId).toBeNull();
    expect(h.gangs.svc.gangStat(g.gangId, BALANCE_STAT)).toBeNull();
    expect(h.gangs.svc.playerStat(S.carol, PENDING_STAT)).toEqual({ InvitingGangs: "" });
    expect(h.events).toEqual([
      ["OnMemberLeft", { gangId: 1, steamId: S.owner, reason: "disband" }],
      ["OnMemberLeft", { gangId: 1, steamId: S.bob, reason: "disband" }],
      ["OnGangDisbanded", { gangId: 1, name: "G" }],
    ]);
    await h.gangs.svc.flush();
    expect(await h.db.query("SELECT * FROM gang_gangs")).toEqual([]);
    expect(await h.db.query("SELECT * FROM gang_gang_stats_gang_native_balance")).toEqual([]);
  });

  it("renames, refusing a taken name", async () => {
    const h = await harness();
    await h.connect(S.owner, "O");
    await h.connect(S.bob, "B");
    h.gangs.svc.createGang("A", S.owner);
    h.gangs.svc.createGang("B", S.bob);
    expect(h.gangs.svc.renameGang(1, "b")).toBe(false);
    expect(h.gangs.svc.renameGang(1, "Alpha")).toBe(true);
    expect(h.eventsNamed("OnGangRenamed")).toEqual([{ gangId: 1, name: "Alpha" }]);
  });

  it("logs a failed write without throwing into the caller", async () => {
    const real = makeTestDb();
    let fail = false;
    const db: Db = {
      query: (s, p) => real.query(s, p),
      execute: (s, p) => (fail && s.startsWith("INSERT INTO gang_gangs") ? Promise.reject(new Error("disk full")) : real.execute(s, p)),
    };
    const h = await harness({ db });
    await h.connect(S.owner, "O");
    fail = true;
    expect(() => h.gangs.svc.createGang("G", S.owner)).not.toThrow();
    expect(h.gangs.svc.getGang(1)).not.toBeNull(); // the cache already reflects it
    await h.gangs.svc.flush();
    expect(h.logs.join("\n")).toMatch(/create gang 1.*disk full/);
  });
});

describe("GangService — membership & ranks", () => {
  async function gangOfThree() {
    const h = await harness();
    await h.connect(S.owner, "Owner");
    await h.connect(S.bob, "Bob");
    await h.connect(S.carol, "Carol");
    const g = h.gangs.svc.createGang("G", S.owner)!;
    h.gangs.svc.addMember(g.gangId, S.bob, 100);
    h.gangs.svc.addMember(g.gangId, S.carol, 50);
    h.events.length = 0;
    return { h, svc: h.gangs.svc, gangId: g.gangId };
  }

  it("addMember requires an existing rank and a gangless, loaded player", async () => {
    const { svc, gangId } = await gangOfThree();
    expect(svc.addMember(gangId, S.bob, 100)).toBe(false); // already a member
    expect(svc.addMember(gangId, S.dave, 100)).toBe(false); // not loaded
    expect(svc.membersOf(gangId).map((m) => m.steam)).toEqual([S.owner, S.carol, S.bob]);
    expect(svc.memberCount(gangId)).toBe(3);
  });

  it("setMemberRank and removeMember emit; the owner cannot be removed", async () => {
    const { h, svc } = await gangOfThree();
    expect(svc.setMemberRank(S.bob, 77)).toBe(false); // no such rank
    expect(svc.setMemberRank(S.bob, 50)).toBe(true);
    expect(svc.removeMember(S.owner, "leave")).toBe(false);
    expect(svc.removeMember(S.carol, "kick")).toBe(true);
    expect(h.events).toEqual([
      ["OnMemberRankChanged", { gangId: 1, steamId: S.bob, oldRank: 100, newRank: 50 }],
      ["OnMemberLeft", { gangId: 1, steamId: S.carol, reason: "kick" }],
    ]);
  });

  it("hasPermission / joinRank / rankNeeded / findInGang read the cache", async () => {
    const { svc, gangId } = await gangOfThree();
    expect(svc.hasPermission(S.owner, Perm.OWNER)).toBe(true);
    expect(svc.hasPermission(S.bob, Perm.KICK_OTHERS)).toBe(false);
    expect(svc.hasPermission(S.carol, Perm.KICK_OTHERS)).toBe(true);
    expect(svc.joinRank(gangId)?.rank).toBe(100);
    expect(svc.rankNeeded(gangId, Perm.KICK_OTHERS)?.rank).toBe(50);
    expect(svc.findInGang(gangId, "car")?.steam).toBe(S.carol);
    expect(svc.findInGang(gangId, S.bob)?.steam).toBe(S.bob);
    expect(svc.findInGang(gangId, "o")).toBeNull(); // ambiguous (Owner, Bob, Carol)
  });

  it("deleteRank honours CANCEL / DEMOTE_FAIL / DEMOTE_KICK", async () => {
    const { h, svc, gangId } = await gangOfThree();
    expect(svc.deleteRank(gangId, 0, DeleteStrat.DEMOTE_KICK)).toBe(false);
    expect(svc.deleteRank(gangId, 50, DeleteStrat.CANCEL)).toBe(false); // carol holds it
    expect(svc.deleteRank(gangId, 50, DeleteStrat.DEMOTE_FAIL)).toBe(true);
    expect(svc.getPlayer(S.carol)?.gangRank).toBe(100);
    expect(svc.deleteRank(gangId, 100, DeleteStrat.DEMOTE_FAIL)).toBe(false); // nothing lower
    expect(svc.deleteRank(gangId, 100, DeleteStrat.DEMOTE_KICK)).toBe(true);
    expect(svc.getPlayer(S.bob)?.gangId).toBeNull();
    expect(svc.ranksOf(gangId).map((r) => r.rank)).toEqual([0, 10, 30]);
    expect(h.eventsNamed("OnMemberLeft")).toHaveLength(2);
  });

  it("createRank refuses OWNER on a non-zero rank and duplicates", async () => {
    const { svc, gangId } = await gangOfThree();
    expect(svc.createRank(gangId, "Boss", 5, Perm.OWNER)).toBeNull();
    expect(svc.createRank(gangId, "Dup", 100, 0)).toBeNull();
    expect(svc.createRank(gangId, "Mid", 75, 0)).toEqual({ rank: 75, name: "Mid", permissions: 0 });
    expect(svc.setRankPermission(gangId, 75, Perm.KICK_OTHERS, true)).toBe(true);
    expect(svc.getRank(gangId, 75)?.permissions).toBe(Perm.KICK_OTHERS);
  });

  it("invites: outgoing list is authoritative, revoke clears both sides", async () => {
    const { svc, gangId } = await gangOfThree();
    await (async () => { svc.playerConnected(S.dave, "Dave"); await svc.flush(); })();
    svc.createInvite(gangId, S.owner, S.dave, 5);
    svc.createInvite(gangId, S.owner, S.dave, 6); // idempotent
    expect(svc.outgoingInvites(gangId)).toEqual([S.dave]);
    expect(svc.pendingInvites(S.dave)).toEqual([gangId]);
    svc.revokeInvite(gangId, S.dave);
    expect(svc.outgoingInvites(gangId)).toEqual([]);
    expect(svc.pendingInvites(S.dave)).toEqual([]);
  });
});
