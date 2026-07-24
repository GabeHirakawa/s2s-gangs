import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";

describe("ensureCoreTables", () => {
  it("creates gangs, players, ranks tables and is idempotent", async () => {
    const db = makeTestDb();
    await ensureCoreTables(db, "gang");
    await ensureCoreTables(db, "gang"); // idempotent
    const names = (await db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )).map((r) => r.name);
    expect(names).toContain("gang_gangs");
    expect(names).toContain("gang_players");
    expect(names).toContain("gang_ranks");
  });
});
