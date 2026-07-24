import type { Db } from "./db";

export async function ensureCoreTables(db: Db, prefix: string): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${prefix}_gangs (GangId INTEGER PRIMARY KEY, Name VARCHAR(255) NOT NULL)`
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${prefix}_players (Steam BIGINT PRIMARY KEY, Name VARCHAR(255), GangId INT, GangRank INT)`
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${prefix}_ranks (GangId INT NOT NULL, ` +
    "`Rank` INT NOT NULL, Name VARCHAR(255) NOT NULL, Permissions INT NOT NULL, " +
    "PRIMARY KEY (GangId, `Rank`))"
  );
}
