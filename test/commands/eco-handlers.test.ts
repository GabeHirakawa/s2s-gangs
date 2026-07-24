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

describe("eco command handlers", () => {
  it("deposit moves personal credits into the gang bank", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    await h.api.eco.grantPlayer("owner", 100);
    await runCommand("sm_gang_deposit", h.ctx("owner", ["40"]));
    expect(await h.api.eco.getGangBalance(gang!.gangId)).toBe(40);
    expect(await h.api.eco.getBalance("owner", true)).toBe(60);
  });

  it("deposit is denied for a rank without BANK_DEPOSIT and writes nothing", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "mute", name: "Mute" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    // a permissionless rank — even the stock Member rank (100) has BANK_DEPOSIT
    await h.api.ranks.create(gang!.gangId, "Mute", 200, 0);
    await runCommand("sm_gang_invite", h.ctx("owner", ["Mute"]));
    await runCommand("sm_gang_join", h.ctx("mute", ["Wolves"]));
    await h.api.members.setRank("mute", 200);
    await h.api.eco.grantPlayer("mute", 100);
    h.replies.length = 0;
    await runCommand("sm_gang_deposit", h.ctx("mute", ["40"]));
    expect(h.replies.join("\n")).toContain("Deposit Money");
    expect(await h.api.eco.getGangBalance(gang!.gangId)).toBe(0);
    expect(await h.api.eco.getBalance("mute", true)).toBe(100);
  });

  it("deposit rejects a non-numeric amount with a usage reply", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    await h.api.eco.grantPlayer("owner", 100);
    h.replies.length = 0;
    await runCommand("sm_gang_deposit", h.ctx("owner", ["40abc"]));
    expect(h.replies.join("\n").toLowerCase()).toContain("usage");
    expect(await h.api.eco.getGangBalance(gang!.gangId)).toBe(0);
    expect(await h.api.eco.getBalance("owner", true)).toBe(100);
  });

  it("balance reports personal credits", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    await h.api.eco.grantPlayer("owner", 30);
    h.replies.length = 0;
    await runCommand("sm_gang_balance", h.ctx("owner", []));
    expect(h.replies.join("\n")).toContain("30");
  });
});
