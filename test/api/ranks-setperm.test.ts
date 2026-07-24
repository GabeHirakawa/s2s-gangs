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
  const a = buildGangsApi({ gangs, players, ranks, stats }, emit);
  return { a, players };
}

describe("api.ranks.setPermission", () => {
  it("setPermission flips a single flag and persists", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    expect(await a.ranks.create(1, "Recruit", 60, 0)).not.toBeNull();
    const { Perm } = await import("../../src/domain/perm");
    expect(await a.ranks.setPermission(1, 60, Perm.KICK_OTHERS, true)).toBe(true);
    expect((await a.ranks.get(1, 60))!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
    await a.ranks.setPermission(1, 60, Perm.KICK_OTHERS, false);
    expect((await a.ranks.get(1, 60))!.permissions & Perm.KICK_OTHERS).toBe(0);
  });
  it("returns false for a missing rank", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    expect(await a.ranks.setPermission(1, 999, 1, true)).toBe(false);
  });
  it("refuses to set OWNER on a non-zero rank via updateRank's existing guard", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    expect(await a.ranks.create(1, "Recruit", 60, 0)).not.toBeNull();
    const { Perm } = await import("../../src/domain/perm");
    expect(await a.ranks.setPermission(1, 60, Perm.OWNER, true)).toBe(false);
  });
});
