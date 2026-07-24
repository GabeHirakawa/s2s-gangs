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
import { dispatch, type CmdCtx, type OnlinePlayer } from "../../src/commands/handlers";
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

describe("command handlers", () => {
  it("create makes a gang and reports success", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    expect(h.replies.join("\n")).toContain("Wolves");
    expect(await h.api.gangs.getByMember("owner")).not.toBeNull();
  });

  it("invite then join moves the invitee into the gang", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    const gang = await h.api.gangs.getByMember("owner");
    await dispatch(h.ctx("owner", ["Bob"]), "invite");
    // bob sees pending, joins by gang name
    await dispatch(h.ctx("bob", ["Wolves"]), "join");
    const bob = await h.api.players.get("bob");
    expect(bob?.gangId).toBe(gang!.gangId);
  });

  it("kick requires KICK_OTHERS and removes a lower member", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    await dispatch(h.ctx("owner", ["Bob"]), "invite");
    await dispatch(h.ctx("bob", ["Wolves"]), "join");
    await dispatch(h.ctx("owner", ["Bob"]), "kick");
    expect((await h.api.players.get("bob"))?.gangId).toBeNull();
  });

  it("a lower-ranked member cannot demote the owner", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    await dispatch(h.ctx("owner", ["Bob"]), "invite");
    await dispatch(h.ctx("bob", ["Wolves"]), "join");   // bob = Member (100)
    await dispatch(h.ctx("owner", ["bob"]), "promote");  // 100 -> 50 Officer
    await dispatch(h.ctx("owner", ["bob"]), "promote");  // 50 -> 30 Manager (has DEMOTE_OTHERS)
    await dispatch(h.ctx("bob", ["owner"]), "demote");   // bob tries to demote the owner
    expect((await h.api.players.get("owner"))?.gangRank).toBe(0); // still owner
  });
});
