import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { GangsRepo } from "../../src/db/gangs.repo";

async function repo() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  return new GangsRepo(db, "gang");
}

describe("GangsRepo", () => {
  it("insert returns the new id; get/all round-trip", async () => {
    const r = await repo();
    const id = await r.insert("Wolves");
    expect(id).toBe(1);
    expect(await r.get(1)).toEqual({ gangId: 1, name: "Wolves" });
    expect(await r.all()).toEqual([{ gangId: 1, name: "Wolves" }]);
  });
  it("updateName and delete report success", async () => {
    const r = await repo();
    const id = await r.insert("A");
    expect(await r.updateName(id, "B")).toBe(true);
    expect((await r.get(id))?.name).toBe("B");
    expect(await r.delete(id)).toBe(true);
    expect(await r.get(id)).toBeNull();
  });
});
