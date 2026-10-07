import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { GangsRepo } from "../../src/store/repo";
import { BALANCE_STAT, INVITATION_STAT, decodeValue, encodeValue, fitsColumn } from "../../src/store/stats";

async function repo() {
  const db = makeTestDb();
  const r = new GangsRepo(db, "gang");
  await r.ensureTables();
  return { db, r };
}

describe("GangsRepo", () => {
  it("creates the upstream tables plus the key/value stat tables (idempotently)", async () => {
    const { db, r } = await repo();
    await r.ensureTables();
    const names = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining([
      "gang_gangs", "gang_players", "gang_ranks",
      "gang_gang_stats_gang_native_balance", "gang_gang_stats_gang_invitation",
      "gang_player_stats_gang_native_balance", "gang_player_stats_pending_invitation",
      "gang_gang_stat_values", "gang_player_stat_values",
    ]));
  });

  it("rejects an unsafe table prefix", () => {
    expect(() => new GangsRepo(makeTestDb(), "x; DROP TABLE y")).toThrow(/identifier/);
  });

  it("round-trips gangs, ranks, members and stats through loadAll", async () => {
    const { r } = await repo();
    await r.insertGang({ gangId: 7, name: "Wolves" });
    await r.insertRank(7, { rank: 0, name: "Owner", permissions: 1 });
    await r.upsertPlayer({ steam: "76561198000000001", name: "O", gangId: 7, gangRank: 0 });
    await r.upsertPlayer({ steam: "76561198000000002", name: "Loner", gangId: null, gangRank: null });
    await r.writeStat("gang", 7, BALANCE_STAT, 50);
    await r.writeStat("gang", 7, "perk:smoke", 2);
    await r.writeStat("gang", 7, INVITATION_STAT, { InvitedSteams: "a", InviterSteams: "b", RequestedSteams: "", Dates: "1", MaxAmo: 5 });
    await r.writeStat("player", "76561198000000001", "kills", 12.5);
    await r.writeStat("player", "76561198000000002", "kills", 3);
    const s = await r.loadAll();
    expect(s.gangs).toEqual([{ gangId: 7, name: "Wolves" }]);
    expect(s.ranks).toEqual([{ gangId: 7, rank: { rank: 0, name: "Owner", permissions: 1 } }]);
    expect(s.members).toEqual([{ steam: "76561198000000001", name: "O", gangId: 7, gangRank: 0 }]);
    expect(s.gangStats).toEqual(expect.arrayContaining([
      { owner: "7", statId: BALANCE_STAT, value: 50 },
      { owner: "7", statId: "perk:smoke", value: 2 },
      { owner: "7", statId: INVITATION_STAT, value: { InvitedSteams: "a", InviterSteams: "b", RequestedSteams: "", Dates: "1", MaxAmo: 5 } },
    ]));
    // only gang members' player stats are part of the boot snapshot
    expect(s.memberStats).toEqual([{ owner: "76561198000000001", statId: "kills", value: 12.5 }]);
  });

  it("loadPlayer creates a missing row and returns its stats", async () => {
    const { r } = await repo();
    const first = await r.loadPlayer("76561198000000009", "New");
    expect(first.player).toEqual({ steam: "76561198000000009", name: "New", gangId: null, gangRank: null });
    await r.writeStat("player", "76561198000000009", BALANCE_STAT, 40);
    const again = await r.loadPlayer("76561198000000009", "Renamed");
    expect(again.player?.name).toBe("New"); // load never overwrites; the service refreshes names
    expect(again.stats).toEqual([{ owner: "76561198000000009", statId: BALANCE_STAT, value: 40 }]);
  });

  it("writeStat(null) deletes; deleteGang removes the gang, ranks, stats and memberships", async () => {
    const { db, r } = await repo();
    await r.insertGang({ gangId: 1, name: "G" });
    await r.insertRank(1, { rank: 0, name: "Owner", permissions: 1 });
    await r.upsertPlayer({ steam: "76561198000000001", name: "O", gangId: 1, gangRank: 0 });
    await r.writeStat("gang", 1, "x", "y");
    await r.writeStat("gang", 1, "x", null);
    expect(await db.query("SELECT * FROM gang_gang_stat_values")).toEqual([]);
    await r.writeStat("gang", 1, BALANCE_STAT, 9);
    await r.deleteGang(1);
    expect(await db.query("SELECT * FROM gang_gangs")).toEqual([]);
    expect(await db.query("SELECT * FROM gang_ranks")).toEqual([]);
    expect(await db.query("SELECT * FROM gang_gang_stats_gang_native_balance")).toEqual([]);
    expect(await db.query("SELECT GangId, GangRank FROM gang_players")).toEqual([{ GangId: null, GangRank: null }]);
  });
});

describe("stat codecs", () => {
  it("JSON-encodes generic values, preserving type", () => {
    for (const v of ["a", "", 1, 2.5, -3, true, false, null]) expect(decodeValue(encodeValue(v))).toEqual(v);
    expect(decodeValue("not json")).toBe("not json");
  });
  it("type-checks native columns", () => {
    expect(fitsColumn("INT", 3)).toBe(true);
    expect(fitsColumn("INT", 3.5)).toBe(false);
    expect(fitsColumn("INT", "3")).toBe(false);
    expect(fitsColumn("VARCHAR(255)", "x".repeat(256))).toBe(false);
    expect(fitsColumn("VARCHAR(255)", null)).toBe(true);
  });
});
