import { describe, it, expect } from "vitest";
import { makeTestDb } from "./sqlite";

describe("makeTestDb", () => {
  it("executes and queries with params, exposes lastInsertId", async () => {
    const db = makeTestDb();
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const r = await db.execute("INSERT INTO t (name) VALUES (?)", ["ada"]);
    expect(r.changes).toBe(1);
    expect(r.lastInsertId).toBe(1);
    const rows = await db.query("SELECT name FROM t WHERE id = ?", [1]);
    expect(rows).toEqual([{ name: "ada" }]);
  });

  it("coerces boolean params to 0/1", async () => {
    const db = makeTestDb();
    await db.execute("CREATE TABLE b (v INT)");
    await db.execute("INSERT INTO b (v) VALUES (?)", [true]);
    expect(await db.query("SELECT v FROM b")).toEqual([{ v: 1 }]);
  });
});
