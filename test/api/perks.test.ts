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

// Harness copied from test/api/eco.test.ts: it registers the balance stats so
// eco.tryPurchase can read gang_native_balance/player_native_balance. Perk stats
// are NOT registered here on purpose — buildGangsApi registers those descriptors.
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
  return { a, players };
}

describe("api.perks", () => {
  it("purchase applies the perk and deducts credits (bank-first via eco)", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner"); // owner has PURCHASE_PERKS
    await a.eco.grantPlayer("owner", 100000);
    const before = await a.perks.getCapacity(1);
    const res = await a.perks.purchase("owner", "gang_native_capacity");
    expect(res.ok).toBe(true);
    expect(await a.perks.getCapacity(1)).toBe(before + 1);
  });
  it("purchase reasons: unknown_perk, not_in_gang, insufficient_funds", async () => {
    const { a, players } = await api();
    await players.createPlayer("solo", "S");
    expect((await a.perks.purchase("solo", "gang_native_capacity")).reason).toBe("not_in_gang");
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    expect((await a.perks.purchase("owner", "nope")).reason).toBe("unknown_perk");
    expect((await a.perks.purchase("owner", "gang_native_capacity")).reason).toBe("insufficient_funds");
  });
  it("purchase reason no_permission for a member on a permissionless rank", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    expect(await a.ranks.create(1, "Mute", 200, 0)).not.toBeNull();
    await players.createPlayer("mute", "M");
    expect(await a.members.add(1, "mute", 200)).toBe(true);
    expect((await a.perks.purchase("mute", "gang_native_capacity")).reason).toBe("no_permission");
  });
  it("purchase reason unpurchasable when the perk is maxed", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await a.stats.setForGang(1, "gang_native_capacity", 15);
    expect((await a.perks.purchase("owner", "gang_native_capacity")).reason).toBe("unpurchasable");
  });
  it("getCapacity defaults to 1", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    expect(await a.perks.getCapacity(1)).toBe(1);
  });
});
