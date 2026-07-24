import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { StatStore, type StatDescriptor } from "../../src/db/instance.repo";

const scalar: StatDescriptor = { id: "gang_door_policy", scope: "gang", kind: "scalar", column: "INT" };
const record: StatDescriptor = {
  id: "gang_invitation", scope: "gang", kind: "record",
  columns: { InvitedSteams: "VARCHAR(255)", MaxAmo: "INT" },
};

describe("StatStore", () => {
  it("scalar stat: table named <prefix>_<id>, single value column, upsert", async () => {
    const db = makeTestDb();
    const store = new StatStore(db, "gang_gang_stats", "GangId", "INTEGER");
    expect(await store.get(scalar, 1)).toBeNull();
    await store.set(scalar, 1, 2);
    expect(await store.get<number>(scalar, 1)).toBe(2);
    await store.set(scalar, 1, 0); // upsert same key
    expect(await store.get<number>(scalar, 1)).toBe(0);
    const tables = (await db.query("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
    expect(tables).toContain("gang_gang_stats_gang_door_policy");
  });
  it("record stat: column per field, upsert merges", async () => {
    const db = makeTestDb();
    const store = new StatStore(db, "gang_gang_stats", "GangId", "INTEGER");
    await store.set(record, 7, { InvitedSteams: "111,222", MaxAmo: 5 });
    expect(await store.get(record, 7)).toEqual({ InvitedSteams: "111,222", MaxAmo: 5 });
    await store.set(record, 7, { InvitedSteams: "111", MaxAmo: 5 });
    expect(await store.get(record, 7)).toEqual({ InvitedSteams: "111", MaxAmo: 5 });
  });
  it("remove on a never-created stat table returns false (no throw)", async () => {
    const db = makeTestDb();
    const store = new StatStore(db, "gang_player_stats", "Steam", "BIGINT");
    expect(await store.remove("gang_door_policy", 999)).toBe(false);
  });
  it("rejects an invalid stat id (no SQL injection via register)", async () => {
    const db = makeTestDb();
    const store = new StatStore(db, "gang_gang_stats", "GangId", "INTEGER");
    const bad = { id: "x; DROP TABLE t", scope: "gang", kind: "scalar", column: "INT" } as const;
    await expect(store.get(bad, 1)).rejects.toThrow(/invalid sql identifier/);
  });
});
