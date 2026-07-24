import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { PlayersRepo } from "../../src/db/players.repo";
import { PlayerManager } from "../../src/managers/player-manager";

async function mgr() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  return new PlayerManager(new PlayersRepo(db, "gang"));
}

describe("PlayerManager", () => {
  it("getPlayer creates on miss when create=true, returns null when create=false", async () => {
    const m = await mgr();
    expect(await m.getPlayer("500", false)).toBeNull();
    const p = await m.getPlayer("500");
    expect(p?.steam).toBe("500");
    expect(await m.getPlayer("500", false)).not.toBeNull();
  });
  it("updatePlayer throws when only one of gangId/gangRank is set", async () => {
    const m = await mgr();
    await m.getPlayer("1");
    await expect(m.updatePlayer({ steam: "1", name: null, gangId: 3, gangRank: null }))
      .rejects.toThrow();
  });
  it("findPlayerInGang matches a unique name", async () => {
    const m = await mgr();
    await m.createPlayer("1", "Alice"); await m.createPlayer("2", "Bob");
    await m.updatePlayer({ steam: "1", name: "Alice", gangId: 9, gangRank: 0 });
    await m.updatePlayer({ steam: "2", name: "Bob", gangId: 9, gangRank: 100 });
    expect((await m.findPlayerInGang(9, "alice"))?.steam).toBe("1");
  });
});
