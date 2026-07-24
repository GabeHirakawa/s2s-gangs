import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { GangsRepo } from "../../src/db/gangs.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { RanksRepo } from "../../src/db/ranks.repo";
import { StatStore } from "../../src/db/instance.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { GangManager } from "../../src/managers/gang-manager";
import { StatManager } from "../../src/managers/stat-manager";
import { buildGangsApi } from "../../src/api/impl";
import type { GangEvents } from "../../src/api/events";
import { route } from "../../src/menus/menu-router";

async function api() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  const ranks = new RankManager(new RanksRepo(db, "gang"), players);
  const gangs = new GangManager(new GangsRepo(db, "gang"), players, ranks);
  const stats = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  const events: Array<[string, unknown]> = [];
  const emit = (<K extends keyof GangEvents>(e: K, p: GangEvents[K]) => events.push([e, p]));
  const a = buildGangsApi({ gangs, players, ranks, stats }, emit);
  return { a, players, events };
}

describe("menu-router", () => {
  it("routes a member action through rctx.run and returns to the members list", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await players.createPlayer("m", "M");
    await a.members.add(1, "m", 100);
    const calls: Array<[string, string[]]> = [];
    const rctx = { api: a, viewerSteam: "owner", run: async (c: string, args: string[]) => { calls.push([c, args]); } };
    const next = await route("action:kick:m", rctx);
    expect(calls).toContainEqual(["sm_gang_kick", ["m"]]);
    expect(next?.title).toBe("Members");
  });
  it("routes door selection and returns to main; unknown info closes", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    const calls: Array<[string, string[]]> = [];
    const rctx = { api: a, viewerSteam: "owner", run: async (c: string, args: string[]) => { calls.push([c, args]); } };
    const next = await route("door:open", rctx);
    expect(calls).toContainEqual(["sm_gang_doorpolicy", ["open"]]);
    expect(next?.title).toContain("Gang");
    expect(await route("bogus", rctx)).toBeNull();
  });
  it("tapping a rank row keeps the Ranks list open rather than closing", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    const calls: Array<[string, string[]]> = [];
    const rctx = { api: a, viewerSteam: "owner", run: async (c: string, args: string[]) => { calls.push([c, args]); } };
    const next = await route("rank:0", rctx);
    expect(next?.title).toBe("Ranks");
    expect(calls).toEqual([]);
  });
});
