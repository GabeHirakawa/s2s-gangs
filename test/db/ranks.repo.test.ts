import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { RanksRepo } from "../../src/db/ranks.repo";

async function repo() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  return new RanksRepo(db, "gang");
}

describe("RanksRepo", () => {
  it("insert/get/forGang round-trip ordered by rank", async () => {
    const r = await repo();
    expect(await r.insert(1, { rank: 100, name: "Member", permissions: 4 })).toBe(true);
    expect(await r.insert(1, { rank: 0, name: "Owner", permissions: 2048 })).toBe(true);
    expect(await r.get(1, 0)).toEqual({ rank: 0, name: "Owner", permissions: 2048 });
    expect((await r.forGang(1)).map((x) => x.rank)).toEqual([0, 100]);
  });
  it("update changes name/permissions; deleteAll clears the gang", async () => {
    const r = await repo();
    await r.insert(1, { rank: 0, name: "Owner", permissions: 1 });
    expect(await r.update(1, { rank: 0, name: "Boss", permissions: 3 })).toBe(true);
    expect(await r.get(1, 0)).toEqual({ rank: 0, name: "Boss", permissions: 3 });
    expect(await r.deleteAll(1)).toBe(true);
    expect(await r.forGang(1)).toEqual([]);
  });
});
