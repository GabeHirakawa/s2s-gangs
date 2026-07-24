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
import { mainMenuModel, membersMenuModel, memberActionsModel, doorPolicyModel } from "../../src/menus/menu-model";

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
  return { a, players, events };
}

describe("menu-model", () => {
  it("main menu hides Ranks entry for a viewer without MANAGE_RANKS", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await players.createPlayer("m", "M");
    await a.members.add(1, "m", 100); // Member: no MANAGE_RANKS
    const owner = await mainMenuModel(a, "owner");
    const member = await mainMenuModel(a, "m");
    expect(owner.items.some((i) => i.info === "nav:ranks")).toBe(true);
    expect(member.items.some((i) => i.info === "nav:ranks")).toBe(false);
    expect(member.items.some((i) => i.info === "nav:members")).toBe(true);
  });
  it("member actions show only permitted verbs and never target self", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await players.createPlayer("m", "M");
    await a.members.add(1, "m", 100);
    const model = await memberActionsModel(a, "owner", "m");
    expect(model!.items.some((i) => i.info === "action:kick:m")).toBe(true);
    const self = await memberActionsModel(a, "owner", "owner");
    expect(self!.items.every((i) => !i.info.startsWith("action:"))).toBe(true);
  });
  it("door policy model has three options", () => {
    expect(doorPolicyModel().items.map((i) => i.info)).toEqual(["door:open", "door:invite", "door:request"]);
  });
  it("members menu lists members with their rank names", async () => {
    const { a, players } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await players.createPlayer("m", "M");
    await a.members.add(1, "m", 100);
    const model = await membersMenuModel(a, 1);
    expect(model.title).toBe("Members");
    expect(model.items.some((i) => i.info === "member:owner")).toBe(true);
    expect(model.items.some((i) => i.info === "member:m")).toBe(true);
  });
});
