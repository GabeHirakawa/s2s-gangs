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
import { buildGangsApi } from "../../src/api/impl";
import type { GangEvents } from "../../src/api/events";

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
  a.stats.register(GANG_BALANCE_STAT); a.stats.register(PLAYER_BALANCE_STAT);
  return { a, players, events };
}

describe("api.eco", () => {
  it("grantPlayer emits player_credits_changed with delta and new balance", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("1", "A");
    expect(await a.eco.grantPlayer("1", 75, "test")).toBe(75);
    expect(events).toContainEqual(["player_credits_changed", { steam: "1", balance: 75, delta: 75, reason: "test" }]);
  });
  it("grantGang emits gang_credits_changed", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await a.eco.grantGang(1, 200, "seed");
    expect(events).toContainEqual(["gang_credits_changed", { gangId: 1, balance: 200, delta: 200, reason: "seed" }]);
  });
});
