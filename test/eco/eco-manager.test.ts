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
import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";
import { EcoManager } from "../../src/eco/eco-manager";

async function harness() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  const ranks = new RankManager(new RanksRepo(db, "gang"), players);
  const gangs = new GangManager(new GangsRepo(db, "gang"), players, ranks);
  const stats = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  stats.register(GANG_BALANCE_STAT); stats.register(PLAYER_BALANCE_STAT);
  const eco = new EcoManager(stats, players, ranks);
  return { players, gangs, eco };
}

describe("EcoManager", () => {
  it("grantPlayer/grantGang accumulate and read back", async () => {
    const { players, eco } = await harness();
    await players.createPlayer("1", "A");
    expect(await eco.grantPlayer("1", 100)).toBe(100);
    expect(await eco.getBalance("1")).toBe(100);
  });

  it("owner (has BANK_WITHDRAW) sees gang bank in total; a member without it does not", async () => {
    const { players, gangs, eco } = await harness();
    await players.createPlayer("owner", "O");
    const gang = await gangs.createGang("G", "owner"); // owner rank 0 has OWNER (incl BANK_WITHDRAW)
    await eco.grantGang(gang!.gangId, 500);
    await eco.grantPlayer("owner", 50);
    expect(await eco.getBalance("owner")).toBe(550);        // 50 + 500 bank
    expect(await eco.getBalance("owner", true)).toBe(50);   // exclude gang
    // a plain Member (rank 100) lacks BANK_WITHDRAW
    await players.createPlayer("m", "M");
    await players.updatePlayer({ steam: "m", name: "M", gangId: gang!.gangId, gangRank: 100 });
    await eco.grantPlayer("m", 20);
    expect(await eco.getBalance("m")).toBe(20);             // bank NOT counted
  });

  it("tryPurchase pulls from gang bank first, then player; unaffordable is a no-op", async () => {
    const { players, gangs, eco } = await harness();
    await players.createPlayer("owner", "O");
    const gang = await gangs.createGang("G", "owner");
    await eco.grantGang(gang!.gangId, 300);
    await eco.grantPlayer("owner", 100);              // total 400
    const remaining = await eco.tryPurchase("owner", 350);
    expect(remaining).toBe(50);
    expect(await eco.getGangBalance(gang!.gangId)).toBe(0);   // 300 bank spent first
    expect(await eco.getBalance("owner", true)).toBe(50);     // then 50 from player
    // unaffordable: no writes
    const before = await eco.getBalance("owner");
    expect(await eco.tryPurchase("owner", 9999)).toBeLessThan(0);
    expect(await eco.getBalance("owner")).toBe(before);
  });
});
