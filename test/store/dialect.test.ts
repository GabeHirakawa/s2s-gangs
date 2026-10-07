import { describe, it, expect } from "vitest";
import { Dialect, parseDialect, DIALECTS } from "../../src/store/dialect";
import { GangsRepo } from "../../src/store/repo";
import type { Db, SqlValue } from "../../src/store/db";

const K = [{ name: "Steam", type: "BIGINT" }];
const V = [{ name: "Name", type: "VARCHAR(255)" }, { name: "GangId", type: "INT" }];

/** A Db that records statements instead of running them. */
function recorder(): { db: Db; log: Array<[string, SqlValue[]]> } {
  const log: Array<[string, SqlValue[]]> = [];
  return {
    log,
    db: {
      async query(sql, params = []) { log.push([sql, params]); return []; },
      async execute(sql, params = []) { log.push([sql, params]); return { changes: 1, lastInsertId: 0 }; },
    },
  };
}

describe("parseDialect", () => {
  it("accepts the three names (+ aliases), defaults empty to sqlite, rejects others", () => {
    expect(parseDialect("")).toBe("sqlite");
    expect(parseDialect(" MySQL ")).toBe("mysql");
    expect(parseDialect("mariadb")).toBe("mysql");
    expect(parseDialect("postgresql")).toBe("postgres");
    expect(parseDialect("oracle")).toBeNull();
  });
});

describe("Dialect SQL generation", () => {
  it("quotes identifiers per dialect", () => {
    expect(new Dialect("sqlite").q("Rank")).toBe("`Rank`");
    expect(new Dialect("mysql").q("Rank")).toBe("`Rank`");
    expect(new Dialect("postgres").q("Rank")).toBe('"Rank"');
  });

  it("casts parameters only on postgres", () => {
    expect(new Dialect("mysql").param("BIGINT")).toBe("?");
    expect(new Dialect("postgres").param("BIGINT")).toBe("CAST(? AS BIGINT)");
    expect(new Dialect("postgres").param("BOOLEAN")).toBe("CAST(CAST(? AS INTEGER) AS BOOLEAN)");
    expect(new Dialect("mysql").castText("`Steam`")).toBe("CAST(`Steam` AS CHAR)");
    expect(new Dialect("postgres").castText('"Steam"')).toBe('CAST("Steam" AS TEXT)');
  });

  it("sqlite upsert", () => {
    expect(new Dialect("sqlite").upsert("gang_players", K, V)).toBe(
      "INSERT INTO `gang_players` (`Steam`, `Name`, `GangId`) VALUES (?, ?, ?) " +
      "ON CONFLICT (`Steam`) DO UPDATE SET `Name` = excluded.`Name`, `GangId` = excluded.`GangId`",
    );
  });

  it("mysql upsert", () => {
    expect(new Dialect("mysql").upsert("gang_players", K, V)).toBe(
      "INSERT INTO `gang_players` (`Steam`, `Name`, `GangId`) VALUES (?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE `Name` = VALUES(`Name`), `GangId` = VALUES(`GangId`)",
    );
  });

  it("postgres upsert", () => {
    expect(new Dialect("postgres").upsert("gang_players", K, V)).toBe(
      'INSERT INTO "gang_players" ("Steam", "Name", "GangId") ' +
      "VALUES (CAST(? AS BIGINT), CAST(? AS VARCHAR(255)), CAST(? AS INT)) " +
      'ON CONFLICT ("Steam") DO UPDATE SET "Name" = EXCLUDED."Name", "GangId" = EXCLUDED."GangId"',
    );
  });

  it("key-only upserts stay valid", () => {
    expect(new Dialect("sqlite").upsert("t", K, [])).toBe("INSERT INTO `t` (`Steam`) VALUES (?) ON CONFLICT (`Steam`) DO NOTHING");
    expect(new Dialect("mysql").upsert("t", K, [])).toBe("INSERT INTO `t` (`Steam`) VALUES (?) ON DUPLICATE KEY UPDATE `Steam` = VALUES(`Steam`)");
  });

  it("CREATE TABLE: composite keys, NOT NULL keys, no AUTOINCREMENT", () => {
    const cols = [{ name: "GangId", type: "INT" }, { name: "Rank", type: "INT" }, { name: "Name", type: "VARCHAR(255)", notNull: true }];
    expect(new Dialect("mysql").createTable("gang_ranks", cols, ["GangId", "Rank"])).toBe(
      "CREATE TABLE IF NOT EXISTS `gang_ranks` (`GangId` INT NOT NULL, `Rank` INT NOT NULL, `Name` VARCHAR(255) NOT NULL, PRIMARY KEY (`GangId`, `Rank`))",
    );
    expect(new Dialect("postgres").createTable("gang_ranks", cols, ["GangId", "Rank"])).toBe(
      'CREATE TABLE IF NOT EXISTS "gang_ranks" ("GangId" INT NOT NULL, "Rank" INT NOT NULL, "Name" VARCHAR(255) NOT NULL, PRIMARY KEY ("GangId", "Rank"))',
    );
  });
});

describe("GangsRepo per dialect", () => {
  for (const name of DIALECTS) {
    it(`${name}: DDL is portable (no AUTOINCREMENT/SERIAL, no TEXT key, every table keyed)`, () => {
      const repo = new GangsRepo(recorder().db, "gang", name);
      const ddl = repo.ddl();
      expect(ddl).toHaveLength(13);
      for (const sql of ddl) {
        expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS /);
        expect(sql).toMatch(/PRIMARY KEY \(/);
        expect(sql).not.toMatch(/AUTOINCREMENT|AUTO_INCREMENT|SERIAL/i);
        // TEXT is only ever the KV Value column, never a key
        const pk = sql.slice(sql.lastIndexOf("PRIMARY KEY"));
        expect(pk).not.toMatch(/Value/);
      }
      const quote = name === "postgres" ? '"' : "`";
      expect(ddl[0]).toBe(`CREATE TABLE IF NOT EXISTS ${quote}gang_gangs${quote} (${quote}GangId${quote} INTEGER NOT NULL, ${quote}Name${quote} VARCHAR(255) NOT NULL, PRIMARY KEY (${quote}GangId${quote}))`);
    });
  }

  it("mysql: statements use backticks, CAST AS CHAR and ON DUPLICATE KEY", async () => {
    const { db, log } = recorder();
    const repo = new GangsRepo(db, "gang", "mysql");
    await repo.loadPlayer("76561198000000001", "A");
    await repo.upsertPlayer({ steam: "76561198000000001", name: "A", gangId: 1, gangRank: 0 });
    await repo.writeStat("gang", 1, "perk:smoke", 2);
    await repo.writeStat("gang", 1, "gang_native_balance", 5);
    const sql = log.map(([s]) => s);
    expect(sql[0]).toBe("SELECT CAST(`Steam` AS CHAR) AS `Steam`, `Name`, `GangId`, `GangRank` FROM `gang_players` WHERE `Steam` = ?");
    expect(sql).toContain(
      "INSERT INTO `gang_gang_stat_values` (`GangId`, `StatId`, `Value`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `Value` = VALUES(`Value`)",
    );
    expect(sql).toContain(
      "INSERT INTO `gang_gang_stats_gang_native_balance` (`GangId`, `gang_native_balance`) VALUES (?, ?) " +
      "ON DUPLICATE KEY UPDATE `gang_native_balance` = VALUES(`gang_native_balance`)",
    );
    expect(sql.join("\n")).not.toMatch(/ON CONFLICT|"|AS TEXT/);
  });

  it("postgres: statements double-quote identifiers and cast every parameter", async () => {
    const { db, log } = recorder();
    const repo = new GangsRepo(db, "gang", "postgres");
    await repo.loadPlayer("76561198000000001", "A");
    await repo.deleteRank(1, 50);
    await repo.writeStat("player", "76561198000000001", "kills", 3);
    const sql = log.map(([s]) => s);
    expect(sql[0]).toBe('SELECT CAST("Steam" AS TEXT) AS "Steam", "Name", "GangId", "GangRank" FROM "gang_players" WHERE "Steam" = CAST(? AS BIGINT)');
    expect(sql).toContain('DELETE FROM "gang_ranks" WHERE "GangId" = CAST(? AS INT) AND "Rank" = CAST(? AS INT)');
    expect(sql).toContain(
      'INSERT INTO "gang_player_stat_values" ("Steam", "StatId", "Value") VALUES (CAST(? AS BIGINT), CAST(? AS VARCHAR(255)), CAST(? AS TEXT)) ' +
      'ON CONFLICT ("Steam", "StatId") DO UPDATE SET "Value" = EXCLUDED."Value"',
    );
    expect(sql.join("\n")).not.toMatch(/`|ON DUPLICATE/);
    // every bare placeholder is wrapped in a cast
    for (const s of sql) expect(s.replace(/CAST\(\? AS [A-Z0-9()]+\)/g, "")).not.toContain("?");
  });
});
