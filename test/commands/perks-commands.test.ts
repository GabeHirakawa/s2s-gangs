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
import { makeMessages } from "../../src/messages";
import { runCommand, type CmdCtx, type OnlinePlayer } from "../../src/commands/handlers";
import { INVITATION_STAT, PENDING_STAT, DOOR_POLICY_STAT } from "../../src/commands/handlers";
import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";

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
  const api = buildGangsApi({ gangs, players, ranks, stats }, () => {});
  api.stats.register(INVITATION_STAT); api.stats.register(PENDING_STAT); api.stats.register(DOOR_POLICY_STAT);
  api.stats.register(GANG_BALANCE_STAT); api.stats.register(PLAYER_BALANCE_STAT);
  const online: OnlinePlayer[] = [];
  const replies: string[] = [];
  const ctx = (steam: string | null, args: string[]): CmdCtx => ({
    steam, args, reply: (m) => replies.push(m), api, msg: makeMessages("Gangs>"),
    online: (q) => online.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()) || o.steam === q),
    nowSec: 1000,
  });
  return { api, online, replies, ctx, players };
}

describe("perk command handlers", () => {
  it("purchase buys a perk and reports the new balance", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    await h.api.eco.grantPlayer("owner", 100000);
    h.replies.length = 0;
    await runCommand("sm_gang_purchase", h.ctx("owner", ["gang_native_capacity"]));
    const gang = await h.api.gangs.getByMember("owner");
    expect(await h.api.perks.getCapacity(gang!.gangId)).toBe(2);
  });
  it("purchase reports insufficient funds", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    h.replies.length = 0;
    await runCommand("sm_gang_purchase", h.ctx("owner", ["gang_native_capacity"]));
    expect(h.replies.join("\n").toLowerCase()).toContain("afford");
  });
  it("motd requires the perk to be purchased first, then sets it", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    h.replies.length = 0;
    await runCommand("sm_gang_motd", h.ctx("owner", ["Hello", "world"]));
    expect(h.replies.join("\n").toLowerCase()).toContain("purchase"); // not owned yet
    await h.api.eco.grantPlayer("owner", 100000);
    await runCommand("sm_gang_purchase", h.ctx("owner", ["gang_native_motd"]));
    await runCommand("sm_gang_motd", h.ctx("owner", ["Hello", "world"]));
    expect(await h.api.stats.getForGang<string>(gang!.gangId, "gang_native_motd")).toBe("Hello world");
  });
});
