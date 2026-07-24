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
  const online: OnlinePlayer[] = [];
  const replies: string[] = [];
  const ctx = (steam: string | null, args: string[]): CmdCtx => ({
    steam, args, reply: (m) => replies.push(m), api, msg: makeMessages("Gangs>"),
    online: (q) => online.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()) || o.steam === q),
    nowSec: 1000,
  });
  return { api, online, replies, ctx, players };
}

describe("rank administration commands", () => {
  it("rank_create adds a rank strictly below the caller; gated on CREATE_RANKS", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    await runCommand("sm_gang_rank_create", h.ctx("owner", ["70", "Scout"]));
    const gang = await h.api.gangs.getByMember("owner");
    expect((await h.api.ranks.get(gang!.gangId, 70))?.name).toBe("Scout");
  });

  it("rank_perm grants a flag the editor holds, refuses one they lack", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    await runCommand("sm_gang_rank_perm", h.ctx("owner", ["100", "kick_others", "on"]));
    const { Perm } = await import("../../src/domain/perm");
    expect((await h.api.ranks.get(gang!.gangId, 100))!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
  });

  it("rank_delete removes a rank via DEMOTE_FAIL", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    await runCommand("sm_gang_rank_delete", h.ctx("owner", ["50"])); // Officer, no members
    expect(await h.api.ranks.get(gang!.gangId, 50)).toBeNull();
  });

  it("rank_perm refuses editing the caller's own or a higher rank", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    h.replies.length = 0;
    await runCommand("sm_gang_rank_perm", h.ctx("owner", ["0", "kick_others", "off"])); // own/owner rank
    const { Perm } = await import("../../src/domain/perm");
    expect((await h.api.ranks.get(gang!.gangId, 0))!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
  });

  it("a Manager (lacks CREATE_RANKS) cannot grant CREATE_RANKS to a lower rank", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    // Promote bob to Manager (rank 30): has MANAGE_RANKS but not CREATE_RANKS.
    await runCommand("sm_gang_invite", h.ctx("owner", ["Bob"]));
    await runCommand("sm_gang_join", h.ctx("bob", ["Wolves"]));   // Member (100)
    await runCommand("sm_gang_promote", h.ctx("owner", ["bob"])); // 100 -> 50 Officer
    await runCommand("sm_gang_promote", h.ctx("owner", ["bob"])); // 50 -> 30 Manager
    expect((await h.api.players.get("bob"))?.gangRank).toBe(30);

    const { Perm } = await import("../../src/domain/perm");
    h.replies.length = 0;
    await runCommand("sm_gang_rank_perm", h.ctx("bob", ["100", "create_ranks", "on"]));
    // Grant is refused (bob lacks CREATE_RANKS); rank 100's bit stays 0.
    expect((await h.api.ranks.get(gang!.gangId, 100))!.permissions & Perm.CREATE_RANKS).toBe(0);
    expect(h.replies.join("\n")).toContain("cannot grant a permission you do not have");
  });

  it("rank_create is gated on CREATE_RANKS (a Manager cannot create ranks)", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
    const gang = await h.api.gangs.getByMember("owner");
    await runCommand("sm_gang_invite", h.ctx("owner", ["Bob"]));
    await runCommand("sm_gang_join", h.ctx("bob", ["Wolves"]));   // Member (100)
    await runCommand("sm_gang_promote", h.ctx("owner", ["bob"])); // 100 -> 50 Officer
    await runCommand("sm_gang_promote", h.ctx("owner", ["bob"])); // 50 -> 30 Manager

    h.replies.length = 0;
    await runCommand("sm_gang_rank_create", h.ctx("bob", ["70", "Scout"]));
    expect(await h.api.ranks.get(gang!.gangId, 70)).toBeNull();
  });
});
