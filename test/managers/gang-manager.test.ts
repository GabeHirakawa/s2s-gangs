import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { GangsRepo } from "../../src/db/gangs.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { RanksRepo } from "../../src/db/ranks.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { GangManager } from "../../src/managers/gang-manager";

async function mgr() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  const ranks = new RankManager(new RanksRepo(db, "gang"), players);
  return { g: new GangManager(new GangsRepo(db, "gang"), players, ranks), players, ranks };
}

describe("GangManager", () => {
  it("createGang makes owner rank 0, assigns default ranks, resolves by member", async () => {
    const { g, players, ranks } = await mgr();
    await players.createPlayer("owner", "O");
    const gang = await g.createGang("Sharks", "owner");
    expect(gang?.gangId).toBe(1);
    const owner = await players.getPlayer("owner", false);
    expect(owner).toMatchObject({ gangId: 1, gangRank: 0 });
    expect((await ranks.getRanks(1)).length).toBe(5);
    expect(await g.getGangByMember("owner")).toEqual({ gangId: 1, name: "Sharks" });
  });
  it("deleteGang clears members and ranks", async () => {
    const { g, players, ranks } = await mgr();
    await players.createPlayer("owner", "O");
    const gang = await g.createGang("Sharks", "owner");
    expect(await g.deleteGang(gang!.gangId)).toBe(true);
    expect(await players.getPlayer("owner", false)).toMatchObject({ gangId: null, gangRank: null });
    expect(await ranks.getRanks(gang!.gangId)).toEqual([]);
    expect(await g.getGang(gang!.gangId)).toBeNull();
  });
});
