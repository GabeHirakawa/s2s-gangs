import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { PlayersRepo } from "../../src/db/players.repo";

async function repo() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  return new PlayersRepo(db, "gang");
}

describe("PlayersRepo", () => {
  it("preserves a full SteamID64 as a string (no precision loss)", async () => {
    const r = await repo();
    const steam = "76561199123456789";
    await r.insert(steam, "Neo");
    const p = await r.get(steam);
    expect(p).toEqual({ steam, name: "Neo", gangId: null, gangRank: null });
  });
  it("update sets gang membership; members ordered by rank", async () => {
    const r = await repo();
    await r.insert("100", "A"); await r.insert("200", "B");
    await r.update({ steam: "100", name: "A", gangId: 1, gangRank: 100 });
    await r.update({ steam: "200", name: "B", gangId: 1, gangRank: 0 });
    const members = await r.members(1);
    expect(members.map((m) => m.steam)).toEqual(["200", "100"]);
  });
});
