import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { RanksRepo } from "../../src/db/ranks.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { Perm } from "../../src/domain/perm";
import { DeleteStrat } from "../../src/domain/types";

async function mgr() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  return { r: new RankManager(new RanksRepo(db, "gang"), players), players };
}

describe("RankManager", () => {
  it("assignDefaultRanks creates the five default ranks", async () => {
    const { r } = await mgr();
    const ranks = await r.assignDefaultRanks(1);
    expect(ranks.map((x) => x.rank)).toEqual([0, 10, 30, 50, 100]);
    expect(await r.getJoinRank(1)).toMatchObject({ rank: 100 });
  });
  it("updateRank refuses to grant OWNER to a non-zero rank", async () => {
    const { r } = await mgr();
    await r.assignDefaultRanks(1);
    expect(await r.updateRank(1, { rank: 10, name: "X", permissions: Perm.OWNER })).toBe(false);
  });
  it("deleteRank CANCEL fails when members hold the rank; DEMOTE_KICK removes them", async () => {
    const { r, players } = await mgr();
    await r.assignDefaultRanks(1);
    await players.createPlayer("77", "M");
    await players.updatePlayer({ steam: "77", name: "M", gangId: 1, gangRank: 100 });
    expect(await r.deleteRank(1, 100, DeleteStrat.CANCEL)).toBe(false);
    expect(await r.deleteRank(1, 100, DeleteStrat.DEMOTE_KICK)).toBe(true);
    const p = await players.getPlayer("77", false);
    expect(p).toMatchObject({ gangId: null, gangRank: null });
  });
});
