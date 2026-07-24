import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { StatStore, type StatDescriptor } from "../../src/db/instance.repo";
import { StatManager } from "../../src/managers/stat-manager";

const door: StatDescriptor = { id: "gang_door_policy", scope: "gang", kind: "scalar", column: "INT" };
const pending: StatDescriptor = {
  id: "pending_invitation", scope: "player", kind: "record", columns: { InvitingGangs: "VARCHAR(255)" },
};

async function mgr() {
  const db = makeTestDb();
  const m = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  m.register(door); m.register(pending);
  return m;
}

describe("StatManager", () => {
  it("routes gang scalar and player record to the right store", async () => {
    const m = await mgr();
    await m.setForGang<number>(1, "gang_door_policy", 2);
    expect(await m.getForGang<number>(1, "gang_door_policy")).toBe(2);
    await m.setForPlayer("500", "pending_invitation", { InvitingGangs: "1,2" });
    expect(await m.getForPlayer("500", "pending_invitation")).toEqual({ InvitingGangs: "1,2" });
  });
  it("throws on an unregistered stat id", async () => {
    const m = await mgr();
    await expect(m.getForGang(1, "nope")).rejects.toThrow(/unregistered/);
  });
});
