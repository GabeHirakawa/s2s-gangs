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
  return { a: buildGangsApi({ gangs, players, ranks, stats }, emit), players, events };
}

describe("buildGangsApi", () => {
  it("create emits gang_created and getMembership resolves the bundle", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("owner", "O");
    const gang = await a.gangs.create("Falcons", "owner");
    expect(gang?.name).toBe("Falcons");
    expect(events).toContainEqual(["gang_created", { gangId: 1, name: "Falcons", ownerSteam: "owner" }]);
    const membership = await a.players.getMembership("owner");
    expect(membership).toMatchObject({ gang: { name: "Falcons" }, rank: { rank: 0 } });
  });
  it("getByMember returns null for a non-member", async () => {
    const { a } = await api();
    expect(await a.gangs.getByMember("ghost")).toBeNull();
  });

  it("members.add/setRank/remove emit lifecycle events", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("Falcons", "owner");
    await players.createPlayer("bob", "Bob");
    expect(await a.members.add(1, "bob", 100)).toBe(true);
    expect(events).toContainEqual(["member_joined", { gangId: 1, steam: "bob", rank: 100 }]);
    await a.members.setRank("bob", 50);
    expect(events).toContainEqual(["member_rank_changed", { gangId: 1, steam: "bob", oldRank: 100, newRank: 50 }]);
    await a.members.remove("bob", "kick");
    expect(events).toContainEqual(["member_left", { gangId: 1, steam: "bob", reason: "kick" }]);
  });

  it("gangs.delete emits member_left(disband) per member then gang_deleted", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("Falcons", "owner");
    expect(await a.gangs.delete(1)).toBe(true);
    expect(events).toContainEqual(["member_left", { gangId: 1, steam: "owner", reason: "disband" }]);
    expect(events).toContainEqual(["gang_deleted", { gangId: 1 }]);
  });
});
