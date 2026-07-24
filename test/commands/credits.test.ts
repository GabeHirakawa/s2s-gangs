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
import { runCredits } from "../../src/commands/credits";

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
  const a = buildGangsApi({ gangs, players, ranks, stats }, () => {});
  a.stats.register(GANG_BALANCE_STAT); a.stats.register(PLAYER_BALANCE_STAT);
  return a;
}

describe("runCredits", () => {
  it("grants credits to a uniquely-resolved online player", async () => {
    const a = await harness();
    const replies: string[] = [];
    await runCredits({
      args: ["Bob", "250"], reply: (m) => replies.push(m), api: a,
      online: () => [{ steam: "9", name: "Bob" }],
    });
    expect(await a.eco.getBalance("9", true)).toBe(250);
    expect(replies.join("\n")).toContain("250");
  });

  it("takes credits with a negative amount", async () => {
    const a = await harness();
    await a.players.create("9", "Bob");
    await a.eco.grantPlayer("9", 100);
    const replies: string[] = [];
    await runCredits({
      args: ["Bob", "-30", "penalty"], reply: (m) => replies.push(m), api: a,
      online: () => [{ steam: "9", name: "Bob" }],
    });
    expect(await a.eco.getBalance("9", true)).toBe(70);
  });

  it("rejects a non-integer amount and writes nothing", async () => {
    const a = await harness();
    const replies: string[] = [];
    await runCredits({
      args: ["Bob", "xx"], reply: (m) => replies.push(m), api: a,
      online: () => [{ steam: "9", name: "Bob" }],
    });
    expect(replies.join("\n").toLowerCase()).toContain("integer");
    expect(await a.eco.getBalance("9", true)).toBe(0);
  });

  it("refuses when the player does not uniquely resolve", async () => {
    const a = await harness();
    const replies: string[] = [];
    await runCredits({ args: ["Nobody", "10"], reply: (m) => replies.push(m), api: a, online: () => [] });
    expect(replies.join("\n")).toContain("Could not find a unique player");
  });
});
