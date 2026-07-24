# Gangs → s2script Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port edgegamers/Gangs to a single s2script `gangs` plugin — faithful DB schema, a published `@gangs/api` for other plugins, and the core `/gang` command lifecycle.

**Architecture:** Single plugin, layered `db/ → managers/ → api/ → commands/`. Repos/managers depend only on a tiny `Db` interface (`query`/`execute`) so they run on the injected s2script `Database` in production and on better-sqlite3 in tests. The whole public API is published under one `@gangs/api` object with lifecycle events.

**Tech Stack:** TypeScript, `@s2script/sdk` `^0.8.0`, `@s2script/cs2` `^0.7.4`, SQLite (built-in driver). Dev: vitest + better-sqlite3.

## Global Constraints

- **Schema is fixed** — table names/columns must match upstream verbatim (prefix default `gang`): `gang_gangs(GangId INTEGER PK, Name VARCHAR(255))`, `gang_players(Steam BIGINT PK, Name VARCHAR(255), GangId INT, GangRank INT)`, `gang_ranks(GangId INT, Rank INT, Name VARCHAR(255), Permissions INT, PK(GangId,Rank))`, dynamic stat tables `<prefix>_gang_stats_<statId>` / `<prefix>_player_stats_<statId>`.
- **SteamID64 crosses every boundary as a `string`.** Reads of the `Steam` column use `CAST(Steam AS TEXT)`. Never let a SteamID64 pass through a JS `number`.
- **API/event payloads are plain JSON data** (structured-copied across the publish boundary) — no methods on returned objects, no live handles.
- **`Perm` values are wire-compatible** with the upstream `[Flags]` enum; `Permissions` is stored as `INT`.
- Expected failures return `null`/`false`/`[]`; only true invariant violations throw.
- No manager caching, no write mutex (single-threaded event loop; use `lastInsertId` for new gang ids).
- Every `SqlValue` is `string | number | boolean | null`. Tests bind via the better-sqlite3 adapter (Task 0), which coerces `boolean → 0/1`.
- TDD: each task ends green and committed. Test files live under `test/` and are excluded from the plugin build (`tsconfig.json` includes only `src`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/db/db.ts` | `Db`, `Row`, `SqlValue`, `ExecuteResult` types (structural match to `@s2script/sdk/db`) |
| `src/db/schema.ts` | `ensureCoreTables(db, prefix)` — the three fixed tables |
| `src/db/gangs.repo.ts` | `GangsRepo` — row CRUD for `<prefix>_gangs` |
| `src/db/players.repo.ts` | `PlayersRepo` — row CRUD for `<prefix>_players` (CAST steam) |
| `src/db/ranks.repo.ts` | `RanksRepo` — row CRUD for `<prefix>_ranks` |
| `src/db/instance.repo.ts` | `StatStore` + `StatDescriptor` — dynamic per-stat tables |
| `src/domain/types.ts` | `Gang`, `GangPlayer`, `GangRank`, `Membership`, `DoorPolicy`, `DeleteStrat` |
| `src/domain/perm.ts` | `Perm` bitflags, `hasPerm`, `describe`, `DEFAULT_RANKS` |
| `src/domain/invitation.ts` | `InvitationData` / `PendingInvitationData` pure serialize helpers |
| `src/managers/player-manager.ts` | `PlayerManager` |
| `src/managers/rank-manager.ts` | `RankManager` |
| `src/managers/gang-manager.ts` | `GangManager` |
| `src/managers/stat-manager.ts` | `StatManager` |
| `src/api/events.ts` | `GangEvents`, `EmitFn` |
| `src/api/impl.ts` | `buildGangsApi(managers, emit): GangsApi` |
| `api.d.ts` | Published contract (`GangsApi` + re-exported DTOs); manifest `types` |
| `src/messages.ts` | English strings + chat-color formatting |
| `src/commands/ctx.ts` | `CmdCtx` type + dispatcher-agnostic helpers |
| `src/commands/*.ts` | one handler per subcommand |
| `src/commands/gang.ts` | `/gang` dispatcher (builds `CmdCtx` from `CommandInvocation`) |
| `src/plugin.ts` | wiring: open DB, build managers, publish API, register command |
| `test/support/sqlite.ts` | better-sqlite3 `Db` adapter for tests |

---

## Task 0: Dev test toolchain

**Files:**
- Modify: `package.json` (devDependencies + `test` script)
- Create: `vitest.config.ts`
- Create: `src/db/db.ts`
- Create: `test/support/sqlite.ts`
- Test: `test/support/sqlite.test.ts`

**Interfaces:**
- Produces:
  - `Db` = `{ query(sql: string, params?: SqlValue[]): Promise<Row[]>; execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult> }`
  - `SqlValue = string | number | boolean | null`, `Row = Record<string, SqlValue>`, `ExecuteResult = { changes: number; lastInsertId: number }`
  - `makeTestDb(): Db` (from `test/support/sqlite.ts`)

- [ ] **Step 1: Add dev deps + script.** Edit `package.json` — add to `devDependencies`: `"vitest": "^2.1.0"`, `"better-sqlite3": "^11.0.0"`, `"@types/better-sqlite3": "^7.6.0"`; add to `scripts`: `"test": "vitest run"`.

- [ ] **Step 2: Install.** Run: `npm install` — Expected: exits 0, `node_modules/vitest` and `node_modules/better-sqlite3` present.

- [ ] **Step 3: vitest config.** Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 4: Db types.** Create `src/db/db.ts`:
```ts
/** Local mirror of @s2script/sdk/db's surface so repos are testable off-runtime.
 *  The real Database (query/execute) satisfies this structurally in production. */
export type SqlValue = string | number | boolean | null;
export type Row = Record<string, SqlValue>;
export interface ExecuteResult { changes: number; lastInsertId: number; }
export interface Db {
  query(sql: string, params?: SqlValue[]): Promise<Row[]>;
  execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult>;
}
```

- [ ] **Step 5: Write the failing test.** Create `test/support/sqlite.test.ts`:
```ts
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
```

- [ ] **Step 6: Run test to verify it fails.** Run: `npm test` — Expected: FAIL, `Cannot find module './sqlite'`.

- [ ] **Step 7: Implement the adapter.** Create `test/support/sqlite.ts`:
```ts
import Database from "better-sqlite3";
import type { Db, ExecuteResult, Row, SqlValue } from "../../src/db/db";

const bind = (p: SqlValue[]): SqlValue[] =>
  p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));

/** In-memory SQLite Db for tests. Same SQL runs in production against the injected Database. */
export function makeTestDb(): Db {
  const sqlite = new Database(":memory:");
  return {
    async query(sql: string, params: SqlValue[] = []): Promise<Row[]> {
      return sqlite.prepare(sql).all(...bind(params)) as Row[];
    },
    async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
      const info = sqlite.prepare(sql).run(...bind(params));
      return { changes: info.changes, lastInsertId: Number(info.lastInsertRowid) };
    },
  };
}
```

- [ ] **Step 8: Run test to verify it passes.** Run: `npm test` — Expected: PASS (2 tests).

- [ ] **Step 9: Commit.**
```bash
git add package.json package-lock.json vitest.config.ts src/db/db.ts test/support/
git commit -m "test: add vitest + better-sqlite3 toolchain and Db interface"
```

---

## Task 1: Domain types & enums

**Files:**
- Create: `src/domain/types.ts`
- Test: `test/domain/types.test.ts`

**Interfaces:**
- Produces:
  - `interface Gang { gangId: number; name: string }`
  - `interface GangPlayer { steam: string; name: string | null; gangId: number | null; gangRank: number | null }`
  - `interface GangRank { rank: number; name: string; permissions: number }`
  - `interface Membership { player: GangPlayer; gang: Gang; rank: GangRank }`
  - `enum DoorPolicy { REQUEST_ONLY = 0, INVITE_ONLY = 1, OPEN = 2 }`
  - `enum DeleteStrat { CANCEL = 0, DEMOTE_FAIL = 1, DEMOTE_KICK = 2 }`

- [ ] **Step 1: Write the failing test.** Create `test/domain/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DoorPolicy, DeleteStrat } from "../../src/domain/types";

describe("domain enums", () => {
  it("DoorPolicy order matches upstream", () => {
    expect([DoorPolicy.REQUEST_ONLY, DoorPolicy.INVITE_ONLY, DoorPolicy.OPEN]).toEqual([0, 1, 2]);
  });
  it("DeleteStrat order matches upstream", () => {
    expect([DeleteStrat.CANCEL, DeleteStrat.DEMOTE_FAIL, DeleteStrat.DEMOTE_KICK]).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/domain/types.test.ts` — Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement.** Create `src/domain/types.ts`:
```ts
export interface Gang { gangId: number; name: string; }
export interface GangPlayer {
  steam: string; name: string | null; gangId: number | null; gangRank: number | null;
}
export interface GangRank { rank: number; name: string; permissions: number; }
export interface Membership { player: GangPlayer; gang: Gang; rank: GangRank; }
export enum DoorPolicy { REQUEST_ONLY = 0, INVITE_ONLY = 1, OPEN = 2 }
export enum DeleteStrat { CANCEL = 0, DEMOTE_FAIL = 1, DEMOTE_KICK = 2 }
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/domain/types.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/domain/types.ts test/domain/types.test.ts
git commit -m "feat: domain types and DoorPolicy/DeleteStrat enums"
```

---

## Task 2: Perm bitflags & helpers

**Files:**
- Create: `src/domain/perm.ts`
- Test: `test/domain/perm.test.ts`

**Interfaces:**
- Consumes: `GangRank` (Task 1).
- Produces:
  - `const Perm` (readonly record of flag → number), including composed `MANAGE_INVITES`, `ADMINISTRATOR`, `OWNER`.
  - `hasPerm(perms: number, flag: number): boolean`
  - `describe(perms: number): string`
  - `DEFAULT_RANKS: GangRank[]` — Owner(0)/Co-Owner(10)/Manager(30)/Officer(50)/Member(100) with exact upstream permission sets.

- [ ] **Step 1: Write the failing test.** Create `test/domain/perm.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Perm, hasPerm, DEFAULT_RANKS } from "../../src/domain/perm";

describe("Perm", () => {
  it("base bit values match upstream", () => {
    expect(Perm.INVITE_OTHERS).toBe(1 << 0);
    expect(Perm.SEND_GANG_CHAT).toBe(1 << 14);
  });
  it("MANAGE_INVITES includes INVITE_OTHERS", () => {
    expect(hasPerm(Perm.MANAGE_INVITES, Perm.INVITE_OTHERS)).toBe(true);
  });
  it("OWNER includes ADMINISTRATOR which includes every base perm", () => {
    for (const flag of [Perm.INVITE_OTHERS, Perm.KICK_OTHERS, Perm.MANAGE_RANKS, Perm.SEND_GANG_CHAT])
      expect(hasPerm(Perm.OWNER, flag)).toBe(true);
    expect(hasPerm(Perm.OWNER, Perm.ADMINISTRATOR)).toBe(true);
  });
  it("DEFAULT_RANKS has owner at rank 0 with OWNER perms and member at 100", () => {
    expect(DEFAULT_RANKS[0]).toMatchObject({ rank: 0, permissions: Perm.OWNER });
    expect(DEFAULT_RANKS.at(-1)).toMatchObject({ rank: 100, name: "Member" });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/domain/perm.test.ts` — Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement.** Create `src/domain/perm.ts`:
```ts
import type { GangRank } from "./types";

const INVITE_OTHERS = 1 << 0, KICK_OTHERS = 1 << 1, BANK_DEPOSIT = 1 << 2, BANK_WITHDRAW = 1 << 3;
const PROMOTE_OTHERS = 1 << 4, DEMOTE_OTHERS = 1 << 5, PURCHASE_PERKS = 1 << 6, MANAGE_PERKS = 1 << 7;
const MANAGE_RANKS = 1 << 8, CREATE_RANKS = 1 << 9, VIEW_MEMBER_DETAILS = 1 << 12, SEND_GANG_CHAT = 1 << 14;
const MANAGE_INVITES = (1 << 13) | INVITE_OTHERS;
const ADMINISTRATOR =
  (1 << 10) | INVITE_OTHERS | KICK_OTHERS | BANK_DEPOSIT | BANK_WITHDRAW | PROMOTE_OTHERS |
  DEMOTE_OTHERS | PURCHASE_PERKS | MANAGE_PERKS | MANAGE_RANKS | CREATE_RANKS |
  VIEW_MEMBER_DETAILS | MANAGE_INVITES | SEND_GANG_CHAT;
const OWNER = (1 << 11) | ADMINISTRATOR;

export const Perm = {
  NONE: 0, INVITE_OTHERS, KICK_OTHERS, BANK_DEPOSIT, BANK_WITHDRAW, PROMOTE_OTHERS, DEMOTE_OTHERS,
  PURCHASE_PERKS, MANAGE_PERKS, MANAGE_RANKS, CREATE_RANKS, VIEW_MEMBER_DETAILS, SEND_GANG_CHAT,
  MANAGE_INVITES, ADMINISTRATOR, OWNER,
} as const;

const FRIENDLY: Record<string, string> = {
  INVITE_OTHERS: "Invite Others", KICK_OTHERS: "Kick Others", BANK_DEPOSIT: "Deposit Money",
  BANK_WITHDRAW: "Use Bank Funds", PROMOTE_OTHERS: "Promote Others", DEMOTE_OTHERS: "Demote Others",
  PURCHASE_PERKS: "Purchase Perks", MANAGE_PERKS: "Manage Perks", MANAGE_RANKS: "Manage Ranks",
  CREATE_RANKS: "Create Ranks", VIEW_MEMBER_DETAILS: "View Member Details",
  MANAGE_INVITES: "Manage Invites", SEND_GANG_CHAT: "Send Gang Chat",
};

export function hasPerm(perms: number, flag: number): boolean {
  return (perms & flag) === flag;
}

export function describe(perms: number): string {
  if (hasPerm(perms, OWNER)) return "Owner";
  if (hasPerm(perms, ADMINISTRATOR)) return "Administrator";
  const names = Object.entries(FRIENDLY)
    .filter(([k]) => hasPerm(perms, (Perm as Record<string, number>)[k]))
    .map(([, v]) => v);
  if (names.length === 0) return "No permissions";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

const MEMBER = BANK_DEPOSIT | VIEW_MEMBER_DETAILS | PURCHASE_PERKS | SEND_GANG_CHAT;
const OFFICER = MEMBER | MANAGE_INVITES | KICK_OTHERS;
const MANAGER = OFFICER | MANAGE_PERKS | MANAGE_RANKS | PROMOTE_OTHERS | DEMOTE_OTHERS | BANK_WITHDRAW;
const CO_OWNER = MANAGER | CREATE_RANKS;

export const DEFAULT_RANKS: GangRank[] = [
  { rank: 0, name: "Owner", permissions: OWNER },
  { rank: 10, name: "Co-Owner", permissions: CO_OWNER },
  { rank: 30, name: "Manager", permissions: MANAGER },
  { rank: 50, name: "Officer", permissions: OFFICER },
  { rank: 100, name: "Member", permissions: MEMBER },
];
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/domain/perm.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/domain/perm.ts test/domain/perm.test.ts
git commit -m "feat: Perm bitflags, hasPerm/describe, DEFAULT_RANKS"
```

---

## Task 3: Invitation serialization helpers

**Files:**
- Create: `src/domain/invitation.ts`
- Test: `test/domain/invitation.test.ts`

**Interfaces:**
- Produces:
  - `interface InvitationData { InvitedSteams: string; InviterSteams: string; RequestedSteams: string; Dates: string; MaxAmo: number }`
  - `emptyInvitation(maxAmo?: number): InvitationData`
  - `addInvitation(d: InvitationData, inviter: string, invited: string, nowSec: number): InvitationData`
  - `removeInvitation(d: InvitationData, invited: string): InvitationData`
  - `invitedList(d: InvitationData): string[]`
  - `interface PendingInvitationData { InvitingGangs: string }`
  - `addPending(p: PendingInvitationData, gangId: number): PendingInvitationData`
  - `removePending(p: PendingInvitationData, gangId: number): PendingInvitationData`
  - `pendingList(p: PendingInvitationData): number[]`

- [ ] **Step 1: Write the failing test.** Create `test/domain/invitation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  emptyInvitation, addInvitation, removeInvitation, invitedList,
  addPending, removePending, pendingList,
} from "../../src/domain/invitation";

describe("invitation data", () => {
  it("adds and lists invited steams as comma-joined strings", () => {
    let d = emptyInvitation();
    d = addInvitation(d, "111", "222", 1000);
    d = addInvitation(d, "111", "333", 1001);
    expect(d.InvitedSteams).toBe("222,333");
    expect(d.InviterSteams).toBe("111,111");
    expect(d.Dates).toBe("1000,1001");
    expect(invitedList(d)).toEqual(["222", "333"]);
  });
  it("removes an invite by keeping the parallel lists aligned", () => {
    let d = addInvitation(addInvitation(emptyInvitation(), "1", "2", 10), "1", "3", 20);
    d = removeInvitation(d, "2");
    expect(invitedList(d)).toEqual(["3"]);
    expect(d.InviterSteams).toBe("1");
    expect(d.Dates).toBe("20");
  });
  it("pending gangs add/remove/list as ints", () => {
    let p = addPending({ InvitingGangs: "" }, 5);
    p = addPending(p, 7);
    expect(pendingList(p)).toEqual([5, 7]);
    p = removePending(p, 5);
    expect(pendingList(p)).toEqual([7]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/domain/invitation.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/domain/invitation.ts`:
```ts
export interface InvitationData {
  InvitedSteams: string; InviterSteams: string; RequestedSteams: string; Dates: string; MaxAmo: number;
}
export interface PendingInvitationData { InvitingGangs: string; }

const split = (s: string): string[] => s.split(",").filter((x) => x.length > 0);
const join = (xs: (string | number)[]): string => xs.join(",");

export const emptyInvitation = (maxAmo = 5): InvitationData => ({
  InvitedSteams: "", InviterSteams: "", RequestedSteams: "", Dates: "", MaxAmo: maxAmo,
});

export const invitedList = (d: InvitationData): string[] => split(d.InvitedSteams);

export function addInvitation(d: InvitationData, inviter: string, invited: string, nowSec: number): InvitationData {
  return {
    ...d,
    InvitedSteams: join([...split(d.InvitedSteams), invited]),
    InviterSteams: join([...split(d.InviterSteams), inviter]),
    Dates: join([...split(d.Dates), nowSec]),
  };
}

export function removeInvitation(d: InvitationData, invited: string): InvitationData {
  const invitedS = split(d.InvitedSteams), inviterS = split(d.InviterSteams), dates = split(d.Dates);
  const i = invitedS.indexOf(invited);
  if (i === -1) return d;
  invitedS.splice(i, 1); inviterS.splice(i, 1); dates.splice(i, 1);
  return { ...d, InvitedSteams: join(invitedS), InviterSteams: join(inviterS), Dates: join(dates) };
}

export const pendingList = (p: PendingInvitationData): number[] =>
  split(p.InvitingGangs).map((x) => parseInt(x, 10));

export const addPending = (p: PendingInvitationData, gangId: number): PendingInvitationData => ({
  InvitingGangs: join([...pendingList(p), gangId]),
});

export const removePending = (p: PendingInvitationData, gangId: number): PendingInvitationData => ({
  InvitingGangs: join(pendingList(p).filter((g) => g !== gangId)),
});
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/domain/invitation.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/domain/invitation.ts test/domain/invitation.test.ts
git commit -m "feat: invitation/pending serialization helpers"
```

---

## Task 4: Schema creation

**Files:**
- Create: `src/db/schema.ts`
- Test: `test/db/schema.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 0).
- Produces: `ensureCoreTables(db: Db, prefix: string): Promise<void>`

- [ ] **Step 1: Write the failing test.** Create `test/db/schema.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/db/schema.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/db/schema.ts`:
```ts
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
```
> Note: `Rank` is backticked because it is a reserved word in some engines; SQLite accepts backticks.

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/db/schema.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/db/schema.ts test/db/schema.test.ts
git commit -m "feat: core table schema creation"
```

---

## Task 5: GangsRepo

**Files:**
- Create: `src/db/gangs.repo.ts`
- Test: `test/db/gangs.repo.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 0), `Gang` (Task 1), `ensureCoreTables` (Task 4).
- Produces: `class GangsRepo` with `constructor(db: Db, prefix: string)` and:
  - `all(): Promise<Gang[]>`
  - `get(id: number): Promise<Gang | null>`
  - `insert(name: string): Promise<number>` (new GangId from `lastInsertId`)
  - `updateName(gangId: number, name: string): Promise<boolean>`
  - `delete(id: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** Create `test/db/gangs.repo.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/db/gangs.repo.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/db/gangs.repo.ts`:
```ts
import type { Db, Row } from "./db";
import type { Gang } from "../domain/types";

const toGang = (r: Row): Gang => ({ gangId: Number(r.GangId), name: String(r.Name) });

export class GangsRepo {
  constructor(private db: Db, private prefix: string) {}
  private get t(): string { return `${this.prefix}_gangs`; }

  async all(): Promise<Gang[]> {
    return (await this.db.query(`SELECT GangId, Name FROM ${this.t}`)).map(toGang);
  }
  async get(id: number): Promise<Gang | null> {
    const rows = await this.db.query(`SELECT GangId, Name FROM ${this.t} WHERE GangId = ?`, [id]);
    return rows.length ? toGang(rows[0]) : null;
  }
  async insert(name: string): Promise<number> {
    const res = await this.db.execute(`INSERT INTO ${this.t} (Name) VALUES (?)`, [name]);
    return res.lastInsertId;
  }
  async updateName(gangId: number, name: string): Promise<boolean> {
    const res = await this.db.execute(`UPDATE ${this.t} SET Name = ? WHERE GangId = ?`, [name, gangId]);
    return res.changes === 1;
  }
  async delete(id: number): Promise<boolean> {
    const res = await this.db.execute(`DELETE FROM ${this.t} WHERE GangId = ?`, [id]);
    return res.changes > 0;
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/db/gangs.repo.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/db/gangs.repo.ts test/db/gangs.repo.test.ts
git commit -m "feat: GangsRepo CRUD"
```

---

## Task 6: PlayersRepo

**Files:**
- Create: `src/db/players.repo.ts`
- Test: `test/db/players.repo.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 0), `GangPlayer` (Task 1), `ensureCoreTables` (Task 4).
- Produces: `class PlayersRepo` with `constructor(db: Db, prefix: string)` and:
  - `get(steam: string): Promise<GangPlayer | null>`
  - `insert(steam: string, name: string | null): Promise<void>`
  - `all(): Promise<GangPlayer[]>`
  - `members(gangId: number): Promise<GangPlayer[]>` (ordered by GangRank ASC)
  - `update(p: GangPlayer): Promise<boolean>`
  - `delete(steam: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** Create `test/db/players.repo.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/db/players.repo.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/db/players.repo.ts`:
```ts
import type { Db, Row } from "./db";
import type { GangPlayer } from "../domain/types";

const toPlayer = (r: Row): GangPlayer => ({
  steam: String(r.Steam),
  name: r.Name === null ? null : String(r.Name),
  gangId: r.GangId === null ? null : Number(r.GangId),
  gangRank: r.GangRank === null ? null : Number(r.GangRank),
});

const SELECT = "SELECT CAST(Steam AS TEXT) AS Steam, Name, GangId, GangRank";

export class PlayersRepo {
  constructor(private db: Db, private prefix: string) {}
  private get t(): string { return `${this.prefix}_players`; }

  async get(steam: string): Promise<GangPlayer | null> {
    const rows = await this.db.query(`${SELECT} FROM ${this.t} WHERE Steam = ?`, [steam]);
    return rows.length ? toPlayer(rows[0]) : null;
  }
  async insert(steam: string, name: string | null): Promise<void> {
    await this.db.execute(`INSERT INTO ${this.t} (Steam, Name) VALUES (?, ?)`, [steam, name]);
  }
  async all(): Promise<GangPlayer[]> {
    return (await this.db.query(`${SELECT} FROM ${this.t}`)).map(toPlayer);
  }
  async members(gangId: number): Promise<GangPlayer[]> {
    return (await this.db.query(
      `${SELECT} FROM ${this.t} WHERE GangId = ? ORDER BY GangRank ASC`, [gangId]
    )).map(toPlayer);
  }
  async update(p: GangPlayer): Promise<boolean> {
    const res = await this.db.execute(
      `UPDATE ${this.t} SET Name = ?, GangId = ?, GangRank = ? WHERE Steam = ?`,
      [p.name, p.gangId, p.gangRank, p.steam]
    );
    return res.changes === 1;
  }
  async delete(steam: string): Promise<boolean> {
    const res = await this.db.execute(`DELETE FROM ${this.t} WHERE Steam = ?`, [steam]);
    return res.changes === 1;
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/db/players.repo.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/db/players.repo.ts test/db/players.repo.test.ts
git commit -m "feat: PlayersRepo CRUD with steam string fidelity"
```

---

## Task 7: RanksRepo

**Files:**
- Create: `src/db/ranks.repo.ts`
- Test: `test/db/ranks.repo.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 0), `GangRank` (Task 1), `ensureCoreTables` (Task 4).
- Produces: `class RanksRepo` with `constructor(db: Db, prefix: string)` and:
  - `forGang(gangId: number): Promise<GangRank[]>` (ordered by Rank ASC)
  - `get(gangId: number, rank: number): Promise<GangRank | null>`
  - `insert(gangId: number, rank: GangRank): Promise<boolean>`
  - `update(gangId: number, rank: GangRank): Promise<boolean>`
  - `delete(gangId: number, rank: number): Promise<boolean>`
  - `deleteAll(gangId: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** Create `test/db/ranks.repo.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/db/ranks.repo.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/db/ranks.repo.ts`:
```ts
import type { Db, Row } from "./db";
import type { GangRank } from "../domain/types";

const toRank = (r: Row): GangRank => ({
  rank: Number(r.Rank), name: String(r.Name), permissions: Number(r.Permissions),
});

export class RanksRepo {
  constructor(private db: Db, private prefix: string) {}
  private get t(): string { return `${this.prefix}_ranks`; }

  async forGang(gangId: number): Promise<GangRank[]> {
    return (await this.db.query(
      "SELECT `Rank`, Name, Permissions FROM " + this.t + " WHERE GangId = ? ORDER BY `Rank` ASC",
      [gangId]
    )).map(toRank);
  }
  async get(gangId: number, rank: number): Promise<GangRank | null> {
    const rows = await this.db.query(
      "SELECT `Rank`, Name, Permissions FROM " + this.t + " WHERE GangId = ? AND `Rank` = ?",
      [gangId, rank]
    );
    return rows.length ? toRank(rows[0]) : null;
  }
  async insert(gangId: number, rank: GangRank): Promise<boolean> {
    const res = await this.db.execute(
      "INSERT INTO " + this.t + " (GangId, `Rank`, Name, Permissions) VALUES (?, ?, ?, ?)",
      [gangId, rank.rank, rank.name, rank.permissions]
    );
    return res.changes === 1;
  }
  async update(gangId: number, rank: GangRank): Promise<boolean> {
    const res = await this.db.execute(
      "UPDATE " + this.t + " SET Name = ?, Permissions = ? WHERE GangId = ? AND `Rank` = ?",
      [rank.name, rank.permissions, gangId, rank.rank]
    );
    return res.changes === 1;
  }
  async delete(gangId: number, rank: number): Promise<boolean> {
    const res = await this.db.execute(
      "DELETE FROM " + this.t + " WHERE GangId = ? AND `Rank` = ?", [gangId, rank]
    );
    return res.changes === 1;
  }
  async deleteAll(gangId: number): Promise<boolean> {
    const res = await this.db.execute("DELETE FROM " + this.t + " WHERE GangId = ?", [gangId]);
    return res.changes > 0;
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/db/ranks.repo.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/db/ranks.repo.ts test/db/ranks.repo.test.ts
git commit -m "feat: RanksRepo CRUD"
```

---

## Task 8: StatStore (dynamic per-stat tables)

**Files:**
- Create: `src/db/instance.repo.ts`
- Test: `test/db/instance.repo.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 0).
- Produces:
  - `type ColumnType = "INT" | "BIGINT" | "VARCHAR(255)" | "REAL" | "BOOLEAN"`
  - `type StatScope = "gang" | "player"`
  - `interface ScalarStat { id: string; scope: StatScope; kind: "scalar"; column: ColumnType }`
  - `interface RecordStat { id: string; scope: StatScope; kind: "record"; columns: Record<string, ColumnType> }`
  - `type StatDescriptor = ScalarStat | RecordStat`
  - `class StatStore` with `constructor(db: Db, tablePrefix: string, pkColumn: string, pkType: string)` and:
    - `get<T>(d: StatDescriptor, key: string | number): Promise<T | null>`
    - `set<T>(d: StatDescriptor, key: string | number, value: T): Promise<boolean>`
    - `remove(statId: string, key: string | number): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** Create `test/db/instance.repo.test.ts`:
```ts
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
  it("get on a never-created stat table returns null (no throw)", async () => {
    const db = makeTestDb();
    const store = new StatStore(db, "gang_player_stats", "Steam", "BIGINT");
    expect(await store.get(scalar, 999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/db/instance.repo.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/db/instance.repo.ts`:
```ts
import type { Db, Row, SqlValue } from "./db";

export type ColumnType = "INT" | "BIGINT" | "VARCHAR(255)" | "REAL" | "BOOLEAN";
export type StatScope = "gang" | "player";
export interface ScalarStat { id: string; scope: StatScope; kind: "scalar"; column: ColumnType; }
export interface RecordStat { id: string; scope: StatScope; kind: "record"; columns: Record<string, ColumnType>; }
export type StatDescriptor = ScalarStat | RecordStat;

const cols = (d: StatDescriptor): Array<[string, ColumnType]> =>
  d.kind === "scalar" ? [[d.id, d.column]] : Object.entries(d.columns);

export class StatStore {
  private ensured = new Set<string>();
  constructor(private db: Db, private tablePrefix: string, private pk: string, private pkType: string) {}

  private table(statId: string): string { return `${this.tablePrefix}_${statId}`; }

  private async ensure(d: StatDescriptor): Promise<void> {
    if (this.ensured.has(d.id)) return;
    const colDefs = cols(d).map(([n, t]) => `${n} ${t}`).join(", ");
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${this.table(d.id)} (${this.pk} ${this.pkType} NOT NULL PRIMARY KEY, ${colDefs})`
    );
    this.ensured.add(d.id);
  }

  async get<T>(d: StatDescriptor, key: string | number): Promise<T | null> {
    await this.ensure(d);
    const names = cols(d).map(([n]) => n);
    const rows = await this.db.query(
      `SELECT ${names.join(", ")} FROM ${this.table(d.id)} WHERE ${this.pk} = ?`, [key]
    );
    if (!rows.length) return null;
    if (d.kind === "scalar") return rows[0][d.id] as unknown as T;
    return rows[0] as unknown as T;
  }

  async set<T>(d: StatDescriptor, key: string | number, value: T): Promise<boolean> {
    await this.ensure(d);
    const entries = cols(d).map(([n]) => n);
    const values: SqlValue[] =
      d.kind === "scalar" ? [value as unknown as SqlValue]
                          : entries.map((n) => (value as Record<string, SqlValue>)[n]);
    const placeholders = entries.map(() => "?").join(", ");
    const updates = entries.map((n) => `${n} = excluded.${n}`).join(", ");
    await this.db.execute(
      `INSERT INTO ${this.table(d.id)} (${this.pk}, ${entries.join(", ")}) ` +
      `VALUES (?, ${placeholders}) ON CONFLICT(${this.pk}) DO UPDATE SET ${updates}`,
      [key, ...values]
    );
    return true;
  }

  async remove(statId: string, key: string | number): Promise<boolean> {
    try {
      const res = await this.db.execute(
        `DELETE FROM ${this.tablePrefix}_${statId} WHERE ${this.pk} = ?`, [key]
      );
      return res.changes > 0;
    } catch (e) {
      if (String(e).includes("no such table")) return false;
      throw e;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/db/instance.repo.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/db/instance.repo.ts test/db/instance.repo.test.ts
git commit -m "feat: StatStore dynamic per-stat tables"
```

---

## Task 9: PlayerManager

**Files:**
- Create: `src/managers/player-manager.ts`
- Test: `test/managers/player-manager.test.ts`

**Interfaces:**
- Consumes: `PlayersRepo` (Task 6), `GangPlayer` (Task 1).
- Produces: `class PlayerManager` with `constructor(players: PlayersRepo)` and:
  - `getPlayer(steam: string, create?: boolean): Promise<GangPlayer | null>` (create defaults `true`)
  - `createPlayer(steam: string, name?: string | null): Promise<GangPlayer>`
  - `getAllPlayers(): Promise<GangPlayer[]>`
  - `getMembers(gangId: number): Promise<GangPlayer[]>`
  - `findPlayerInGang(gangId: number, query: string): Promise<GangPlayer | null>`
  - `updatePlayer(p: GangPlayer): Promise<boolean>` (throws if exactly one of gangId/gangRank is null)
  - `deletePlayer(steam: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** Create `test/managers/player-manager.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/managers/player-manager.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/managers/player-manager.ts`:
```ts
import type { PlayersRepo } from "../db/players.repo";
import type { GangPlayer } from "../domain/types";

export class PlayerManager {
  constructor(private players: PlayersRepo) {}

  async getPlayer(steam: string, create = true): Promise<GangPlayer | null> {
    const existing = await this.players.get(steam);
    if (existing || !create) return existing;
    return this.createPlayer(steam);
  }

  async createPlayer(steam: string, name: string | null = null): Promise<GangPlayer> {
    const existing = await this.players.get(steam);
    if (existing) return existing;
    await this.players.insert(steam, name);
    return { steam, name, gangId: null, gangRank: null };
  }

  getAllPlayers(): Promise<GangPlayer[]> { return this.players.all(); }
  getMembers(gangId: number): Promise<GangPlayer[]> { return this.players.members(gangId); }

  async findPlayerInGang(gangId: number, query: string): Promise<GangPlayer | null> {
    const members = await this.players.members(gangId);
    const bySteam = members.filter((p) => query.includes(p.steam));
    if (bySteam.length === 1) return bySteam[0];
    const q = query.toLowerCase();
    const byName = members.filter((p) => p.name !== null && p.name.toLowerCase().includes(q));
    return byName.length === 1 ? byName[0] : null;
  }

  updatePlayer(p: GangPlayer): Promise<boolean> {
    if ((p.gangId === null) !== (p.gangRank === null))
      throw new Error("Player must have both GangId and GangRank set or neither set");
    return this.players.update(p);
  }

  deletePlayer(steam: string): Promise<boolean> { return this.players.delete(steam); }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/managers/player-manager.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/managers/player-manager.ts test/managers/player-manager.test.ts
git commit -m "feat: PlayerManager"
```

---

## Task 10: RankManager

**Files:**
- Create: `src/managers/rank-manager.ts`
- Test: `test/managers/rank-manager.test.ts`

**Interfaces:**
- Consumes: `RanksRepo` (Task 7), `PlayerManager` (Task 9), `GangRank`/`GangPlayer`/`DeleteStrat` (Task 1), `Perm`/`DEFAULT_RANKS`/`hasPerm` (Task 2).
- Produces: `class RankManager` with `constructor(ranks: RanksRepo, players: PlayerManager)` and:
  - `getRanks(gangId: number): Promise<GangRank[]>`
  - `getRank(gangId: number, rank: number): Promise<GangRank | null>`
  - `addRank(gangId: number, rank: GangRank): Promise<boolean>` (false if rank<0 or exists)
  - `createRank(gangId: number, name: string, rank: number, permissions: number): Promise<GangRank | null>`
  - `updateRank(gangId: number, rank: GangRank): Promise<boolean>` (false if rank<0, or rank>0 with OWNER bit)
  - `deleteRank(gangId: number, rank: number, strat: DeleteStrat): Promise<boolean>`
  - `deleteAllRanks(gangId: number): Promise<boolean>`
  - `assignDefaultRanks(gangId: number): Promise<GangRank[]>`
  - `getJoinRank(gangId: number): Promise<GangRank | null>` (highest rank number)
  - `getRankNeeded(gangId: number, perm: number): Promise<GangRank | null>` (lowest-ranked rank with perm)
  - `checkRank(player: GangPlayer, perm: number): Promise<{ ok: boolean; required: GangRank | null }>`

- [ ] **Step 1: Write the failing test.** Create `test/managers/rank-manager.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { RanksRepo } from "../../src/db/ranks.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { Perm } from "../../src/domain/perm";
import { DeleteStrat } from "../../src/domain/types";

async function mgr() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  return { r: new RankManager(new RanksRepo(db, "gang"), players), players };
}

describe("RankManager", () => {
  it("assignDefaultRanks creates the five default ranks", async () => {
    const { r } = await mgr();
    const ranks = await r.assignDefaultRanks(1);
    expect(ranks.map((x) => x.rank)).toEqual([0, 10, 30, 50, 100]);
    expect(await r.getJoinRank(1)).toMatchObject({ rank: 100 });
  });
  it("updateRank refuses to grant OWNER to a non-zero rank", async () => {
    const { r } = await mgr();
    await r.assignDefaultRanks(1);
    expect(await r.updateRank(1, { rank: 10, name: "X", permissions: Perm.OWNER })).toBe(false);
  });
  it("deleteRank CANCEL fails when members hold the rank; DEMOTE_KICK removes them", async () => {
    const { r, players } = await mgr();
    await r.assignDefaultRanks(1);
    await players.createPlayer("77", "M");
    await players.updatePlayer({ steam: "77", name: "M", gangId: 1, gangRank: 100 });
    expect(await r.deleteRank(1, 100, DeleteStrat.CANCEL)).toBe(false);
    expect(await r.deleteRank(1, 100, DeleteStrat.DEMOTE_KICK)).toBe(true);
    const p = await players.getPlayer("77", false);
    expect(p).toMatchObject({ gangId: null, gangRank: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/managers/rank-manager.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/managers/rank-manager.ts`:
```ts
import type { RanksRepo } from "../db/ranks.repo";
import type { PlayerManager } from "./player-manager";
import type { GangRank, GangPlayer } from "../domain/types";
import { DeleteStrat } from "../domain/types";
import { Perm, hasPerm, DEFAULT_RANKS } from "../domain/perm";

export class RankManager {
  constructor(private ranks: RanksRepo, private players: PlayerManager) {}

  getRanks(gangId: number): Promise<GangRank[]> { return this.ranks.forGang(gangId); }
  getRank(gangId: number, rank: number): Promise<GangRank | null> { return this.ranks.get(gangId, rank); }

  async addRank(gangId: number, rank: GangRank): Promise<boolean> {
    if (rank.rank < 0) return false;
    if (await this.ranks.get(gangId, rank.rank)) return false;
    return this.ranks.insert(gangId, rank);
  }

  async createRank(gangId: number, name: string, rank: number, permissions: number): Promise<GangRank | null> {
    const obj: GangRank = { rank, name, permissions };
    return (await this.addRank(gangId, obj)) ? obj : null;
  }

  async updateRank(gangId: number, rank: GangRank): Promise<boolean> {
    if (rank.rank < 0) return false;
    if (rank.rank > 0 && hasPerm(rank.permissions, Perm.OWNER)) return false;
    return this.ranks.update(gangId, rank);
  }

  async deleteRank(gangId: number, rank: number, strat: DeleteStrat): Promise<boolean> {
    if (rank <= 0) return false;
    const members = (await this.players.getMembers(gangId)).filter((p) => p.gangRank === rank);
    if (strat === DeleteStrat.CANCEL && members.length > 0) return false;

    const all = await this.ranks.forGang(gangId);
    const lower = all.filter((r) => r.rank > rank).sort((a, b) => a.rank - b.rank)[0] ?? null;
    if (strat === DeleteStrat.DEMOTE_FAIL && lower === null && members.length > 0) return false;

    for (const p of members) {
      const next: GangPlayer = lower
        ? { ...p, gangId, gangRank: lower.rank }
        : { ...p, gangId: null, gangRank: null };
      await this.players.updatePlayer(next);
    }
    return this.ranks.delete(gangId, rank);
  }

  deleteAllRanks(gangId: number): Promise<boolean> { return this.ranks.deleteAll(gangId); }

  async assignDefaultRanks(gangId: number): Promise<GangRank[]> {
    const created: GangRank[] = [];
    for (const r of DEFAULT_RANKS) {
      const made = await this.createRank(gangId, r.name, r.rank, r.permissions);
      if (!made) throw new Error(`Failed to create default rank ${r.name}`);
      created.push(made);
    }
    return created;
  }

  async getJoinRank(gangId: number): Promise<GangRank | null> {
    const ranks = await this.ranks.forGang(gangId);
    return ranks.length ? ranks[ranks.length - 1] : null;
  }

  async getRankNeeded(gangId: number, perm: number): Promise<GangRank | null> {
    const ranks = await this.ranks.forGang(gangId);
    const withPerm = ranks.filter((r) => hasPerm(r.permissions, perm));
    return withPerm.length ? withPerm[withPerm.length - 1] : null;
  }

  async checkRank(player: GangPlayer, perm: number): Promise<{ ok: boolean; required: GangRank | null }> {
    if (player.gangId === null || player.gangRank === null) return { ok: false, required: null };
    const required = await this.getRankNeeded(player.gangId, perm);
    const rank = await this.ranks.get(player.gangId, player.gangRank);
    return { ok: rank !== null && hasPerm(rank.permissions, perm), required };
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/managers/rank-manager.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/managers/rank-manager.ts test/managers/rank-manager.test.ts
git commit -m "feat: RankManager with default ranks and delete strategies"
```

---

## Task 11: GangManager

**Files:**
- Create: `src/managers/gang-manager.ts`
- Test: `test/managers/gang-manager.test.ts`

**Interfaces:**
- Consumes: `GangsRepo` (Task 5), `PlayerManager` (Task 9), `RankManager` (Task 10), `Gang` (Task 1).
- Produces: `class GangManager` with `constructor(gangs: GangsRepo, players: PlayerManager, ranks: RankManager)` and:
  - `getGangs(): Promise<Gang[]>`
  - `getGang(id: number): Promise<Gang | null>`
  - `getGangByMember(steam: string): Promise<Gang | null>`
  - `createGang(name: string, ownerSteam: string): Promise<Gang | null>` (null if owner already in a gang returns null via caller check; throws only on hard invariant)
  - `updateGang(gang: Gang): Promise<boolean>`
  - `deleteGang(id: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** Create `test/managers/gang-manager.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { GangsRepo } from "../../src/db/gangs.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { RanksRepo } from "../../src/db/ranks.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { GangManager } from "../../src/managers/gang-manager";

async function mgr() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  const ranks = new RankManager(new RanksRepo(db, "gang"), players);
  return { g: new GangManager(new GangsRepo(db, "gang"), players, ranks), players, ranks };
}

describe("GangManager", () => {
  it("createGang makes owner rank 0, assigns default ranks, resolves by member", async () => {
    const { g, players, ranks } = await mgr();
    await players.createPlayer("owner", "O");
    const gang = await g.createGang("Sharks", "owner");
    expect(gang?.gangId).toBe(1);
    const owner = await players.getPlayer("owner", false);
    expect(owner).toMatchObject({ gangId: 1, gangRank: 0 });
    expect((await ranks.getRanks(1)).length).toBe(5);
    expect(await g.getGangByMember("owner")).toEqual({ gangId: 1, name: "Sharks" });
  });
  it("deleteGang clears members and ranks", async () => {
    const { g, players, ranks } = await mgr();
    await players.createPlayer("owner", "O");
    const gang = await g.createGang("Sharks", "owner");
    expect(await g.deleteGang(gang!.gangId)).toBe(true);
    expect(await players.getPlayer("owner", false)).toMatchObject({ gangId: null, gangRank: null });
    expect(await ranks.getRanks(gang!.gangId)).toEqual([]);
    expect(await g.getGang(gang!.gangId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/managers/gang-manager.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/managers/gang-manager.ts`:
```ts
import type { GangsRepo } from "../db/gangs.repo";
import type { PlayerManager } from "./player-manager";
import type { RankManager } from "./rank-manager";
import type { Gang } from "../domain/types";

export class GangManager {
  constructor(private gangs: GangsRepo, private players: PlayerManager, private ranks: RankManager) {}

  getGangs(): Promise<Gang[]> { return this.gangs.all(); }
  getGang(id: number): Promise<Gang | null> { return this.gangs.get(id); }

  async getGangByMember(steam: string): Promise<Gang | null> {
    const player = await this.players.getPlayer(steam, false);
    if (!player || player.gangId === null) return null;
    return this.gangs.get(player.gangId);
  }

  async createGang(name: string, ownerSteam: string): Promise<Gang | null> {
    const player = await this.players.getPlayer(ownerSteam);
    if (!player) return null;
    if (player.gangId !== null)
      throw new Error(`Player ${ownerSteam} is already in gang ${player.gangId}`);

    const id = await this.gangs.insert(name);
    if (!id) return null;
    await this.ranks.assignDefaultRanks(id);
    await this.players.updatePlayer({ ...player, gangId: id, gangRank: 0 });
    return { gangId: id, name };
  }

  updateGang(gang: Gang): Promise<boolean> { return this.gangs.updateName(gang.gangId, gang.name); }

  async deleteGang(id: number): Promise<boolean> {
    const members = await this.players.getMembers(id);
    for (const m of members) await this.players.updatePlayer({ ...m, gangId: null, gangRank: null });
    await this.ranks.deleteAllRanks(id);
    return this.gangs.delete(id);
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/managers/gang-manager.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/managers/gang-manager.ts test/managers/gang-manager.test.ts
git commit -m "feat: GangManager create/delete with cascade"
```

---

## Task 12: StatManager

**Files:**
- Create: `src/managers/stat-manager.ts`
- Test: `test/managers/stat-manager.test.ts`

**Interfaces:**
- Consumes: `StatStore`, `StatDescriptor` (Task 8).
- Produces: `class StatManager` with `constructor(gangStore: StatStore, playerStore: StatStore)` and:
  - `register(d: StatDescriptor): void`
  - `getForGang<T>(gangId: number, statId: string): Promise<T | null>`
  - `setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean>`
  - `removeFromGang(gangId: number, statId: string): Promise<boolean>`
  - `getForPlayer<T>(steam: string, statId: string): Promise<T | null>`
  - `setForPlayer<T>(steam: string, statId: string, value: T): Promise<boolean>`
  - `removeFromPlayer(steam: string, statId: string): Promise<boolean>`
  - Lookups throw `Error("unregistered stat: <id>")` if the statId/scope is unknown.

- [ ] **Step 1: Write the failing test.** Create `test/managers/stat-manager.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/managers/stat-manager.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/managers/stat-manager.ts`:
```ts
import type { StatStore, StatDescriptor, StatScope } from "../db/instance.repo";

export class StatManager {
  private descriptors = new Map<string, StatDescriptor>();
  constructor(private gangStore: StatStore, private playerStore: StatStore) {}

  register(d: StatDescriptor): void { this.descriptors.set(`${d.scope}:${d.id}`, d); }

  private descriptor(scope: StatScope, statId: string): StatDescriptor {
    const d = this.descriptors.get(`${scope}:${statId}`);
    if (!d) throw new Error(`unregistered stat: ${statId}`);
    return d;
  }

  getForGang<T>(gangId: number, statId: string): Promise<T | null> {
    return this.gangStore.get<T>(this.descriptor("gang", statId), gangId);
  }
  setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean> {
    return this.gangStore.set<T>(this.descriptor("gang", statId), gangId, value);
  }
  removeFromGang(gangId: number, statId: string): Promise<boolean> {
    this.descriptor("gang", statId);
    return this.gangStore.remove(statId, gangId);
  }
  getForPlayer<T>(steam: string, statId: string): Promise<T | null> {
    return this.playerStore.get<T>(this.descriptor("player", statId), steam);
  }
  setForPlayer<T>(steam: string, statId: string, value: T): Promise<boolean> {
    return this.playerStore.set<T>(this.descriptor("player", statId), steam, value);
  }
  removeFromPlayer(steam: string, statId: string): Promise<boolean> {
    this.descriptor("player", statId);
    return this.playerStore.remove(statId, steam);
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/managers/stat-manager.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/managers/stat-manager.ts test/managers/stat-manager.test.ts
git commit -m "feat: StatManager scope routing"
```

---

## Task 13: Event definitions

**Files:**
- Create: `src/api/events.ts`
- Test: `test/api/events.test.ts`

**Interfaces:**
- Produces:
  - `interface GangEvents { gang_created: {...}; gang_deleted: {...}; gang_renamed: {...}; member_joined: {...}; member_left: {...}; member_rank_changed: {...}; invite_created: {...}; invite_revoked: {...} }` (payloads per spec §5)
  - `type EmitFn = <K extends keyof GangEvents>(event: K, payload: GangEvents[K]) => void`
  - `const GANG_EVENTS: readonly (keyof GangEvents)[]` (runtime list for tests/docs)

- [ ] **Step 1: Write the failing test.** Create `test/api/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GANG_EVENTS } from "../../src/api/events";

describe("GangEvents", () => {
  it("lists the eight lifecycle events", () => {
    expect([...GANG_EVENTS].sort()).toEqual([
      "gang_created", "gang_deleted", "gang_renamed", "invite_created",
      "invite_revoked", "member_joined", "member_left", "member_rank_changed",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/api/events.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/api/events.ts`:
```ts
export interface GangEvents {
  gang_created: { gangId: number; name: string; ownerSteam: string };
  gang_deleted: { gangId: number };
  gang_renamed: { gangId: number; name: string };
  member_joined: { gangId: number; steam: string; rank: number };
  member_left: { gangId: number; steam: string; reason: "leave" | "kick" | "disband" };
  member_rank_changed: { gangId: number; steam: string; oldRank: number; newRank: number };
  invite_created: { gangId: number; inviter: string; invited: string };
  invite_revoked: { gangId: number; invited: string };
}

export type EmitFn = <K extends keyof GangEvents>(event: K, payload: GangEvents[K]) => void;

export const GANG_EVENTS: readonly (keyof GangEvents)[] = [
  "gang_created", "gang_deleted", "gang_renamed", "member_joined",
  "member_left", "member_rank_changed", "invite_created", "invite_revoked",
];
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/api/events.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/api/events.ts test/api/events.test.ts
git commit -m "feat: gang lifecycle event definitions"
```

---

## Task 14: buildGangsApi + published contract

**Files:**
- Create: `src/api/impl.ts`
- Create: `api.d.ts`
- Test: `test/api/impl.test.ts`

**Interfaces:**
- Consumes: all four managers (Tasks 9–12), `EmitFn`/`GangEvents` (Task 13), domain types (Task 1), `StatDescriptor` (Task 8).
- Produces:
  - `interface Managers { gangs: GangManager; players: PlayerManager; ranks: RankManager; stats: StatManager }`
  - `buildGangsApi(m: Managers, emit: EmitFn): GangsApi`
  - `api.d.ts` exports `GangsApi` and re-exports DTOs (`Gang`, `GangPlayer`, `GangRank`, `Membership`, `DoorPolicy`, `DeleteStrat`, `Perm`, `StatDescriptor`, `GangEvents`).
- The `GangsApi` interface shape is exactly spec §5 plus `players.getMembership`.

- [ ] **Step 1: Write the failing test.** Create `test/api/impl.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { GangsRepo } from "../../src/db/gangs.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { RanksRepo } from "../../src/db/ranks.repo";
import { StatStore } from "../../src/db/instance.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { GangManager } from "../../src/managers/gang-manager";
import { StatManager } from "../../src/managers/stat-manager";
import { buildGangsApi } from "../../src/api/impl";
import type { GangEvents } from "../../src/api/events";

async function api() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  const ranks = new RankManager(new RanksRepo(db, "gang"), players);
  const gangs = new GangManager(new GangsRepo(db, "gang"), players, ranks);
  const stats = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  const events: Array<[string, unknown]> = [];
  const emit = (<K extends keyof GangEvents>(e: K, p: GangEvents[K]) => events.push([e, p]));
  return { a: buildGangsApi({ gangs, players, ranks, stats }, emit), players, events };
}

describe("buildGangsApi", () => {
  it("create emits gang_created and getMembership resolves the bundle", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("owner", "O");
    const gang = await a.gangs.create("Falcons", "owner");
    expect(gang?.name).toBe("Falcons");
    expect(events).toContainEqual(["gang_created", { gangId: 1, name: "Falcons", ownerSteam: "owner" }]);
    const membership = await a.players.getMembership("owner");
    expect(membership).toMatchObject({ gang: { name: "Falcons" }, rank: { rank: 0 } });
  });
  it("getByMember returns null for a non-member", async () => {
    const { a } = await api();
    expect(await a.gangs.getByMember("ghost")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/api/impl.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `api.d.ts`.** Create `api.d.ts` at repo root:
```ts
export type { Gang, GangPlayer, GangRank, Membership } from "./src/domain/types";
export { DoorPolicy, DeleteStrat } from "./src/domain/types";
export { Perm } from "./src/domain/perm";
export type { StatDescriptor } from "./src/db/instance.repo";
export type { GangEvents } from "./src/api/events";
import type { Gang, GangPlayer, GangRank, Membership, DeleteStrat } from "./src/domain/types";
import type { StatDescriptor } from "./src/db/instance.repo";

export interface GangsApi {
  gangs: {
    getAll(): Promise<Gang[]>;
    get(id: number): Promise<Gang | null>;
    getByMember(steam: string): Promise<Gang | null>;
    create(name: string, ownerSteam: string): Promise<Gang | null>;
    updateName(gangId: number, name: string): Promise<boolean>;
    delete(id: number): Promise<boolean>;
  };
  players: {
    get(steam: string, create?: boolean): Promise<GangPlayer | null>;
    create(steam: string, name?: string | null): Promise<GangPlayer>;
    getAll(): Promise<GangPlayer[]>;
    getMembers(gangId: number): Promise<GangPlayer[]>;
    findInGang(gangId: number, query: string): Promise<GangPlayer | null>;
    getMembership(steam: string): Promise<Membership | null>;
    update(p: GangPlayer): Promise<boolean>;
    delete(steam: string): Promise<boolean>;
  };
  ranks: {
    getAll(gangId: number): Promise<GangRank[]>;
    get(gangId: number, rank: number): Promise<GangRank | null>;
    create(gangId: number, name: string, rank: number, permissions: number): Promise<GangRank | null>;
    update(gangId: number, rank: GangRank): Promise<boolean>;
    delete(gangId: number, rank: number, strat: DeleteStrat): Promise<boolean>;
    assignDefaults(gangId: number): Promise<GangRank[]>;
    checkPermission(steam: string, perm: number): Promise<boolean>;
    getJoinRank(gangId: number): Promise<GangRank | null>;
    getRankNeeded(gangId: number, perm: number): Promise<GangRank | null>;
  };
  stats: {
    register(d: StatDescriptor): void;
    getForGang<T>(gangId: number, statId: string): Promise<T | null>;
    setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean>;
    removeFromGang(gangId: number, statId: string): Promise<boolean>;
    getForPlayer<T>(steam: string, statId: string): Promise<T | null>;
    setForPlayer<T>(steam: string, statId: string, value: T): Promise<boolean>;
    removeFromPlayer(steam: string, statId: string): Promise<boolean>;
  };
}
```
> Verify `s2s build` accepts a re-exporting contract. If it rejects re-exports, inline the DTO/enum declarations directly into `api.d.ts` (they must match the domain definitions).

- [ ] **Step 4: Implement `src/api/impl.ts`.** Create it:
```ts
import type { GangManager } from "../managers/gang-manager";
import type { PlayerManager } from "../managers/player-manager";
import type { RankManager } from "../managers/rank-manager";
import type { StatManager } from "../managers/stat-manager";
import type { EmitFn } from "./events";
import type { GangsApi } from "../../api";
import type { Membership } from "../domain/types";

export interface Managers {
  gangs: GangManager; players: PlayerManager; ranks: RankManager; stats: StatManager;
}

export function buildGangsApi(m: Managers, emit: EmitFn): GangsApi {
  return {
    gangs: {
      getAll: () => m.gangs.getGangs(),
      get: (id) => m.gangs.getGang(id),
      getByMember: (steam) => m.gangs.getGangByMember(steam),
      async create(name, ownerSteam) {
        const gang = await m.gangs.createGang(name, ownerSteam);
        if (gang) emit("gang_created", { gangId: gang.gangId, name: gang.name, ownerSteam });
        return gang;
      },
      async updateName(gangId, name) {
        const ok = await m.gangs.updateGang({ gangId, name });
        if (ok) emit("gang_renamed", { gangId, name });
        return ok;
      },
      async delete(id) {
        const ok = await m.gangs.deleteGang(id);
        if (ok) emit("gang_deleted", { gangId: id });
        return ok;
      },
    },
    players: {
      get: (steam, create) => m.players.getPlayer(steam, create),
      create: (steam, name) => m.players.createPlayer(steam, name ?? null),
      getAll: () => m.players.getAllPlayers(),
      getMembers: (gangId) => m.players.getMembers(gangId),
      findInGang: (gangId, query) => m.players.findPlayerInGang(gangId, query),
      async getMembership(steam): Promise<Membership | null> {
        const player = await m.players.getPlayer(steam, false);
        if (!player || player.gangId === null || player.gangRank === null) return null;
        const gang = await m.gangs.getGang(player.gangId);
        const rank = await m.ranks.getRank(player.gangId, player.gangRank);
        if (!gang || !rank) return null;
        return { player, gang, rank };
      },
      update: (p) => m.players.updatePlayer(p),
      delete: (steam) => m.players.deletePlayer(steam),
    },
    ranks: {
      getAll: (gangId) => m.ranks.getRanks(gangId),
      get: (gangId, rank) => m.ranks.getRank(gangId, rank),
      create: (gangId, name, rank, permissions) => m.ranks.createRank(gangId, name, rank, permissions),
      update: (gangId, rank) => m.ranks.updateRank(gangId, rank),
      delete: (gangId, rank, strat) => m.ranks.deleteRank(gangId, rank, strat),
      assignDefaults: (gangId) => m.ranks.assignDefaultRanks(gangId),
      async checkPermission(steam, perm) {
        const player = await m.players.getPlayer(steam, false);
        if (!player) return false;
        return (await m.ranks.checkRank(player, perm)).ok;
      },
      getJoinRank: (gangId) => m.ranks.getJoinRank(gangId),
      getRankNeeded: (gangId, perm) => m.ranks.getRankNeeded(gangId, perm),
    },
    stats: {
      register: (d) => m.stats.register(d),
      getForGang: (gangId, statId) => m.stats.getForGang(gangId, statId),
      setForGang: (gangId, statId, value) => m.stats.setForGang(gangId, statId, value),
      removeFromGang: (gangId, statId) => m.stats.removeFromGang(gangId, statId),
      getForPlayer: (steam, statId) => m.stats.getForPlayer(steam, statId),
      setForPlayer: (steam, statId, value) => m.stats.setForPlayer(steam, statId, value),
      removeFromPlayer: (steam, statId) => m.stats.removeFromPlayer(steam, statId),
    },
  };
}
```

- [ ] **Step 5: Run to verify it passes.** Run: `npm test test/api/impl.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/api/impl.ts api.d.ts test/api/impl.test.ts
git commit -m "feat: buildGangsApi and published @gangs/api contract"
```

---

## Task 15: Messages module

**Files:**
- Create: `src/messages.ts`
- Test: `test/messages.test.ts`

**Interfaces:**
- Produces: `const msg` — an object of functions returning formatted strings for the core commands (e.g. `notInGang()`, `created(name, id)`, `invited(target, gang)`, `noPermission(node)`, `usage(text)`, `joined(gang)`, `left(name)`, `kicked(name)`, `disbandWarning()`, `memberLine(name, rankName)`). Strings prefixed with the configured chat tag; colors via `@s2script/sdk/chat` `ChatColors` if available, else plain.

- [ ] **Step 1: Write the failing test.** Create `test/messages.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeMessages } from "../src/messages";

describe("messages", () => {
  it("formats with the configured tag and interpolates values", () => {
    const msg = makeMessages("Gangs>");
    expect(msg.created("Wolves", 3)).toContain("Wolves");
    expect(msg.created("Wolves", 3)).toContain("Gangs>");
    expect(msg.noPermission("Kick Others")).toContain("Kick Others");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/messages.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/messages.ts`:
```ts
/** Self-contained English strings. Kept plain-text here so they are testable off-runtime;
 *  chat color tokens can be layered in later without changing call sites. */
export interface Messages {
  notInGang(): string;
  created(name: string, id: number): string;
  alreadyInGang(): string;
  invited(target: string, gang: string): string;
  joined(gang: string): string;
  left(name: string): string;
  kicked(name: string): string;
  promoted(name: string, rank: string): string;
  demoted(name: string, rank: string): string;
  memberLine(name: string, rank: string): string;
  noPermission(node: string): string;
  usage(text: string): string;
  disbandWarning(): string;
  disbanded(name: string): string;
  playerNotFound(query: string): string;
}

export function makeMessages(tag: string): Messages {
  const p = (s: string): string => `${tag} ${s}`;
  return {
    notInGang: () => p("You are not in a gang. Type /gang create [name] to create one."),
    created: (name, id) => p(`Successfully created the '${name}' (${id}) gang.`),
    alreadyInGang: () => p("You are already in a gang."),
    invited: (target, gang) => p(`You invited ${target} to ${gang}.`),
    joined: (gang) => p(`You joined ${gang}.`),
    left: (name) => p(`${name} left the gang.`),
    kicked: (name) => p(`Kicked ${name} from the gang.`),
    promoted: (name, rank) => p(`Promoted ${name} to ${rank}.`),
    demoted: (name, rank) => p(`Demoted ${name} to ${rank}.`),
    memberLine: (name, rank) => `  ${name} — ${rank}`,
    noPermission: (node) => p(`You are missing the ${node} permission.`),
    usage: (text) => p(`Usage: ${text}`),
    disbandWarning: () =>
      p("WARNING: This is irreversible. Type /gang disband confirm to confirm."),
    disbanded: (name) => p(`${name} disbanded the gang.`),
    playerNotFound: (query) => p(`Could not find a player using "${query}".`),
  };
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test test/messages.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/messages.ts test/messages.test.ts
git commit -m "feat: self-contained messages module"
```

---

## Task 16: Command context + core subcommand handlers

**Files:**
- Create: `src/commands/ctx.ts`
- Create: `src/commands/handlers.ts`
- Test: `test/commands/handlers.test.ts`

**Interfaces:**
- Consumes: `GangsApi` (Task 14), `Messages` (Task 15), `Perm` (Task 2), invitation helpers (Task 3), `DoorPolicy`/`DeleteStrat` (Task 1).
- Produces:
  - `interface OnlinePlayer { steam: string; name: string }`
  - `interface CmdCtx { steam: string | null; args: string[]; reply(msg: string): void; api: GangsApi; msg: Messages; online(query: string): OnlinePlayer[]; nowSec: number }`
  - `handlers: Record<string, (ctx: CmdCtx) => Promise<void>>` keyed by subcommand: `create`, `invite`, `invites`, `pending`, `join`, `leave`, `kick`, `promote`, `demote`, `transfer`, `members`, `doorpolicy`, `disband`, `help`, and `""` (bare `/gang`).
  - `dispatch(ctx: CmdCtx, sub: string): Promise<void>` — routes to a handler, replying usage/help for unknown subs.

This task carries the largest logic surface. Implement handlers to use only `ctx.api`, `ctx.msg`, `ctx.online`, and the invitation helpers — no DB access — so they are unit-testable with the real in-memory API. Stat ids used: `gang_invitation` (gang record), `pending_invitation` (player record), `gang_door_policy` (gang scalar). Registration of those descriptors happens in `plugin.ts` (Task 17); tests register them on the same api instance.

- [ ] **Step 1: Write the failing test.** Create `test/commands/handlers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { ensureCoreTables } from "../../src/db/schema";
import { GangsRepo } from "../../src/db/gangs.repo";
import { PlayersRepo } from "../../src/db/players.repo";
import { RanksRepo } from "../../src/db/ranks.repo";
import { StatStore } from "../../src/db/instance.repo";
import { PlayerManager } from "../../src/managers/player-manager";
import { RankManager } from "../../src/managers/rank-manager";
import { GangManager } from "../../src/managers/gang-manager";
import { StatManager } from "../../src/managers/stat-manager";
import { buildGangsApi } from "../../src/api/impl";
import { makeMessages } from "../../src/messages";
import { dispatch, type CmdCtx, type OnlinePlayer } from "../../src/commands/handlers";
import { INVITATION_STAT, PENDING_STAT, DOOR_POLICY_STAT } from "../../src/commands/handlers";

async function harness() {
  const db = makeTestDb();
  await ensureCoreTables(db, "gang");
  const players = new PlayerManager(new PlayersRepo(db, "gang"));
  const ranks = new RankManager(new RanksRepo(db, "gang"), players);
  const gangs = new GangManager(new GangsRepo(db, "gang"), players, ranks);
  const stats = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  const api = buildGangsApi({ gangs, players, ranks, stats }, () => {});
  api.stats.register(INVITATION_STAT); api.stats.register(PENDING_STAT); api.stats.register(DOOR_POLICY_STAT);
  const online: OnlinePlayer[] = [];
  const replies: string[] = [];
  const ctx = (steam: string | null, args: string[]): CmdCtx => ({
    steam, args, reply: (m) => replies.push(m), api, msg: makeMessages("Gangs>"),
    online: (q) => online.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()) || o.steam === q),
    nowSec: 1000,
  });
  return { api, online, replies, ctx, players };
}

describe("command handlers", () => {
  it("create makes a gang and reports success", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    expect(h.replies.join("\n")).toContain("Wolves");
    expect(await h.api.gangs.getByMember("owner")).not.toBeNull();
  });

  it("invite then join moves the invitee into the gang", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    const gang = await h.api.gangs.getByMember("owner");
    await dispatch(h.ctx("owner", ["Bob"]), "invite");
    // bob sees pending, joins by gang name
    await dispatch(h.ctx("bob", ["Wolves"]), "join");
    const bob = await h.api.players.get("bob");
    expect(bob?.gangId).toBe(gang!.gangId);
  });

  it("kick requires KICK_OTHERS and removes a lower member", async () => {
    const h = await harness();
    h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
    await dispatch(h.ctx("owner", ["Wolves"]), "create");
    await dispatch(h.ctx("owner", ["Bob"]), "invite");
    await dispatch(h.ctx("bob", ["Wolves"]), "join");
    await dispatch(h.ctx("owner", ["Bob"]), "kick");
    expect((await h.api.players.get("bob"))?.gangId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test test/commands/handlers.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/ctx.ts`.** Create it:
```ts
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";

export interface OnlinePlayer { steam: string; name: string; }

export interface CmdCtx {
  steam: string | null;                 // caller SteamID64, null for console
  args: string[];                       // args after the subcommand
  reply(message: string): void;
  api: GangsApi;
  msg: Messages;
  online(query: string): OnlinePlayer[]; // resolve currently-connected players
  nowSec: number;                       // current unix seconds (injected; keeps handlers pure)
}
```

- [ ] **Step 4: Implement `src/commands/handlers.ts`.** Create it:
```ts
import type { CmdCtx } from "./ctx";
export type { CmdCtx, OnlinePlayer } from "./ctx";
import type { StatDescriptor } from "../db/instance.repo";
import { Perm } from "../domain/perm";
import { DoorPolicy, DeleteStrat } from "../domain/types";
import {
  emptyInvitation, addInvitation, removeInvitation, invitedList,
  addPending, removePending, pendingList, type InvitationData, type PendingInvitationData,
} from "../domain/invitation";

export const INVITATION_STAT: StatDescriptor = {
  id: "gang_invitation", scope: "gang", kind: "record",
  columns: {
    InvitedSteams: "VARCHAR(255)", InviterSteams: "VARCHAR(255)",
    RequestedSteams: "VARCHAR(255)", Dates: "VARCHAR(255)", MaxAmo: "INT",
  },
};
export const PENDING_STAT: StatDescriptor = {
  id: "pending_invitation", scope: "player", kind: "record", columns: { InvitingGangs: "VARCHAR(255)" },
};
export const DOOR_POLICY_STAT: StatDescriptor = {
  id: "gang_door_policy", scope: "gang", kind: "scalar", column: "INT",
};

async function requireGang(ctx: CmdCtx): Promise<{ steam: string; gangId: number; rank: number } | null> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return null; }
  const p = await ctx.api.players.get(ctx.steam, false);
  if (!p || p.gangId === null || p.gangRank === null) { ctx.reply(ctx.msg.notInGang()); return null; }
  return { steam: ctx.steam, gangId: p.gangId, rank: p.gangRank };
}

async function gate(ctx: CmdCtx, steam: string, perm: number, node: string): Promise<boolean> {
  if (await ctx.api.ranks.checkPermission(steam, perm)) return true;
  ctx.reply(ctx.msg.noPermission(node));
  return false;
}

async function cmdCreate(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const name = ctx.args.join(" ").trim();
  if (!name) { ctx.reply(ctx.msg.usage("/gang create [name]")); return; }
  const existing = await ctx.api.players.get(ctx.steam, false);
  if (existing?.gangId != null) { ctx.reply(ctx.msg.alreadyInGang()); return; }
  await ctx.api.players.create(ctx.steam, ctx.online(ctx.steam)[0]?.name ?? null);
  const gang = await ctx.api.gangs.create(name, ctx.steam);
  ctx.reply(gang ? ctx.msg.created(gang.name, gang.gangId) : "Failed to create gang.");
}

async function cmdInvite(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.INVITE_OTHERS, "Invite Others"))) return;
  const query = ctx.args.join(" ").trim();
  const matches = ctx.online(query);
  if (matches.length !== 1) { ctx.reply(ctx.msg.playerNotFound(query)); return; }
  const target = matches[0];
  const data = (await ctx.api.stats.getForGang<InvitationData>(me.gangId, "gang_invitation"))
    ?? emptyInvitation();
  await ctx.api.stats.setForGang(me.gangId, "gang_invitation",
    addInvitation(data, me.steam, target.steam, ctx.nowSec));
  const pending = (await ctx.api.stats.getForPlayer<PendingInvitationData>(target.steam, "pending_invitation"))
    ?? { InvitingGangs: "" };
  await ctx.api.stats.setForPlayer(target.steam, "pending_invitation", addPending(pending, me.gangId));
  const gang = await ctx.api.gangs.get(me.gangId);
  ctx.reply(ctx.msg.invited(target.name, gang?.name ?? String(me.gangId)));
}

async function cmdInvites(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const data = await ctx.api.stats.getForGang<InvitationData>(me.gangId, "gang_invitation");
  const list = data ? invitedList(data) : [];
  ctx.reply(list.length ? `Outgoing invites: ${list.join(", ")}` : "Your gang has not invited anyone.");
}

async function cmdPending(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const pending = await ctx.api.stats.getForPlayer<PendingInvitationData>(ctx.steam, "pending_invitation");
  const gangs = pending ? pendingList(pending) : [];
  if (!gangs.length) { ctx.reply("You have no pending invites."); return; }
  const names: string[] = [];
  for (const id of gangs) names.push((await ctx.api.gangs.get(id))?.name ?? `#${id}`);
  ctx.reply(`Invited by: ${names.join(", ")}. Use /gang join [name] to accept.`);
}

async function resolveGangByName(ctx: CmdCtx, query: string): Promise<number | null> {
  const q = query.trim().toLowerCase();
  const all = await ctx.api.gangs.getAll();
  const byName = all.filter((g) => g.name.toLowerCase() === q);
  if (byName.length === 1) return byName[0].gangId;
  const partial = all.filter((g) => g.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0].gangId : null;
}

async function cmdJoin(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const player = await ctx.api.players.get(ctx.steam, false);
  if (player?.gangId != null) { ctx.reply(ctx.msg.alreadyInGang()); return; }
  const gangId = await resolveGangByName(ctx, ctx.args.join(" "));
  if (gangId === null) { ctx.reply("Could not find that gang."); return; }

  const policy = (await ctx.api.stats.getForGang<number>(gangId, "gang_door_policy")) ?? DoorPolicy.REQUEST_ONLY;
  const invite = await ctx.api.stats.getForGang<InvitationData>(gangId, "gang_invitation");
  const invited = invite ? invitedList(invite).includes(ctx.steam) : false;
  if (policy !== DoorPolicy.OPEN && !invited) { ctx.reply("You need an invite to join this gang."); return; }

  await ctx.api.players.create(ctx.steam, ctx.online(ctx.steam)[0]?.name ?? null);
  const joinRank = await ctx.api.ranks.getJoinRank(gangId);
  const fresh = await ctx.api.players.get(ctx.steam);
  if (!fresh || !joinRank) { ctx.reply("Failed to join."); return; }
  await ctx.api.players.update({ ...fresh, gangId, gangRank: joinRank.rank });

  if (invite) await ctx.api.stats.setForGang(gangId, "gang_invitation", removeInvitation(invite, ctx.steam));
  const pending = await ctx.api.stats.getForPlayer<PendingInvitationData>(ctx.steam, "pending_invitation");
  if (pending) await ctx.api.stats.setForPlayer(ctx.steam, "pending_invitation", removePending(pending, gangId));
  const gang = await ctx.api.gangs.get(gangId);
  ctx.reply(ctx.msg.joined(gang?.name ?? String(gangId)));
}

async function cmdLeave(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (me.rank === 0) { ctx.reply("Owners must transfer or disband, not leave."); return; }
  const p = await ctx.api.players.get(me.steam);
  if (p) await ctx.api.players.update({ ...p, gangId: null, gangRank: null });
  ctx.reply(ctx.msg.left(p?.name ?? me.steam));
}

async function cmdKick(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.KICK_OTHERS, "Kick Others"))) return;
  const target = await ctx.api.players.findInGang(me.gangId, ctx.args.join(" "));
  if (!target || target.gangRank === null) { ctx.reply(ctx.msg.playerNotFound(ctx.args.join(" "))); return; }
  if (target.gangRank <= me.rank) { ctx.reply("You cannot kick someone of equal or higher rank."); return; }
  await ctx.api.players.update({ ...target, gangId: null, gangRank: null });
  ctx.reply(ctx.msg.kicked(target.name ?? target.steam));
}

async function changeRank(ctx: CmdCtx, dir: "promote" | "demote"): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const perm = dir === "promote" ? Perm.PROMOTE_OTHERS : Perm.DEMOTE_OTHERS;
  if (!(await gate(ctx, me.steam, perm, dir === "promote" ? "Promote Others" : "Demote Others"))) return;
  const target = await ctx.api.players.findInGang(me.gangId, ctx.args.join(" "));
  if (!target || target.gangRank === null) { ctx.reply(ctx.msg.playerNotFound(ctx.args.join(" "))); return; }
  const ranks = await ctx.api.ranks.getAll(me.gangId);
  const sorted = ranks.map((r) => r.rank).sort((a, b) => a - b);
  const idx = sorted.indexOf(target.gangRank);
  const nextRank = dir === "promote" ? sorted[idx - 1] : sorted[idx + 1];
  if (nextRank === undefined) { ctx.reply("No rank to move to."); return; }
  if (dir === "promote" && nextRank <= me.rank) { ctx.reply("You cannot promote above yourself."); return; }
  await ctx.api.players.update({ ...target, gangRank: nextRank });
  const rankObj = ranks.find((r) => r.rank === nextRank)!;
  ctx.reply(dir === "promote"
    ? ctx.msg.promoted(target.name ?? target.steam, rankObj.name)
    : ctx.msg.demoted(target.name ?? target.steam, rankObj.name));
}

async function cmdTransfer(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  const target = await ctx.api.players.findInGang(me.gangId, ctx.args.join(" "));
  if (!target || target.gangRank === null || target.steam === me.steam) {
    ctx.reply(ctx.msg.playerNotFound(ctx.args.join(" "))); return;
  }
  const joinRank = await ctx.api.ranks.getJoinRank(me.gangId);
  const oldOwner = await ctx.api.players.get(me.steam);
  await ctx.api.players.update({ ...target, gangRank: 0 });
  if (oldOwner) await ctx.api.players.update({ ...oldOwner, gangRank: joinRank?.rank ?? me.rank });
  ctx.reply(`Transferred ownership to ${target.name ?? target.steam}.`);
}

async function cmdMembers(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const members = await ctx.api.players.getMembers(me.gangId);
  const ranks = await ctx.api.ranks.getAll(me.gangId);
  const rankName = (n: number | null): string => ranks.find((r) => r.rank === n)?.name ?? "?";
  ctx.reply("Members:");
  for (const m of members) ctx.reply(ctx.msg.memberLine(m.name ?? m.steam, rankName(m.gangRank)));
}

async function cmdDoorPolicy(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const map: Record<string, DoorPolicy> = {
    open: DoorPolicy.OPEN, invite: DoorPolicy.INVITE_ONLY, request: DoorPolicy.REQUEST_ONLY,
  };
  const choice = map[(ctx.args[0] ?? "").toLowerCase()];
  if (choice === undefined) { ctx.reply(ctx.msg.usage("/gang doorpolicy [open|invite|request]")); return; }
  await ctx.api.stats.setForGang(me.gangId, "gang_door_policy", choice);
  ctx.reply(`Door policy set to ${ctx.args[0].toLowerCase()}.`);
}

async function cmdDisband(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  if ((ctx.args[0] ?? "").toLowerCase() !== "confirm") { ctx.reply(ctx.msg.disbandWarning()); return; }
  const gang = await ctx.api.gangs.get(me.gangId);
  await ctx.api.gangs.delete(me.gangId);
  ctx.reply(ctx.msg.disbanded(gang?.name ?? String(me.gangId)));
}

async function cmdInfo(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const membership = await ctx.api.players.getMembership(ctx.steam);
  if (!membership) { ctx.reply(ctx.msg.notInGang()); return; }
  const count = (await ctx.api.players.getMembers(membership.gang.gangId)).length;
  ctx.reply(`${membership.gang.name} — your rank: ${membership.rank.name} — members: ${count}`);
}

function cmdHelp(ctx: CmdCtx): Promise<void> {
  const subs = "create, invite, invites, pending, join, leave, kick, promote, demote, transfer, members, doorpolicy, disband";
  ctx.reply(ctx.msg.usage(`/gang [${subs}]`));
  return Promise.resolve();
}

export const handlers: Record<string, (ctx: CmdCtx) => Promise<void>> = {
  "": cmdInfo, create: cmdCreate, invite: cmdInvite, invites: cmdInvites, pending: cmdPending,
  join: cmdJoin, leave: cmdLeave, kick: cmdKick,
  promote: (ctx) => changeRank(ctx, "promote"), demote: (ctx) => changeRank(ctx, "demote"),
  transfer: cmdTransfer, members: cmdMembers, doorpolicy: cmdDoorPolicy, disband: cmdDisband, help: cmdHelp,
};

export async function dispatch(ctx: CmdCtx, sub: string): Promise<void> {
  const handler = handlers[sub.toLowerCase()] ?? handlers.help;
  await handler(ctx);
}
```

- [ ] **Step 5: Run to verify it passes.** Run: `npm test test/commands/handlers.test.ts` — Expected: PASS.

- [ ] **Step 6: Run the full suite.** Run: `npm test` — Expected: all tests PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/commands/ctx.ts src/commands/handlers.ts test/commands/handlers.test.ts
git commit -m "feat: core /gang subcommand handlers"
```

---

## Task 17: Plugin wiring + manifest + dispatcher

**Files:**
- Modify: `src/plugin.ts` (replace stub)
- Create: `src/commands/gang.ts`
- Modify: `package.json` (add `s2script` manifest block)

**Interfaces:**
- Consumes: everything. Produces the loadable plugin artifact.

- [ ] **Step 1: Add the manifest block.** Edit `package.json` — add a top-level `"s2script"` key and top-level `"types"`:
```json
  "types": "api.d.ts",
  "s2script": {
    "id": "gangs",
    "publishes": "self",
    "config": {
      "table_prefix": "gang",
      "db_connection": "default",
      "currency_name": "credits",
      "chat_tag": "Gangs>"
    }
  }
```
> If `s2s build` reports the `types` path must live under `s2script`, move `"types": "api.d.ts"` inside the `s2script` block instead. Keep `"main": "src/plugin.ts"`.

- [ ] **Step 2: Implement the dispatcher.** Create `src/commands/gang.ts`:
```ts
import type { CommandInvocation } from "@s2script/sdk/commands";
import { Clients } from "@s2script/sdk/clients";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import { dispatch } from "./handlers";
import type { CmdCtx, OnlinePlayer } from "./ctx";

/** Build a CmdCtx from a runtime CommandInvocation and run the matching subcommand. */
export function runGangCommand(api: GangsApi, msg: Messages, cmd: CommandInvocation): void {
  const caller = cmd.callerSlot >= 0 ? Clients.fromSlot(cmd.callerSlot) : null;
  const steam = caller && caller.steamId !== "0" ? caller.steamId : null;
  const sub = cmd.arg(0);
  const args = cmd.argsFrom(1).length ? cmd.argsFrom(1).split(/\s+/) : [];

  const online = (query: string): OnlinePlayer[] => {
    const q = query.toLowerCase();
    return Clients.all()
      .filter((c) => c.isValid() && !c.isBot)
      .map((c) => ({ steam: c.steamId, name: c.name }))
      .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
  };

  const ctx: CmdCtx = {
    steam, args, reply: (m) => cmd.reply(m), api, msg, online,
    nowSec: Math.floor(Date.now() / 1000),
  };
  void dispatch(ctx, sub);
}
```
> Note: `Date.now()` is available in the plugin runtime (it is only restricted inside Workflow scripts). Handlers stay pure by receiving `nowSec` through `CmdCtx`.

- [ ] **Step 3: Implement `src/plugin.ts`.** Replace the stub:
```ts
import { plugin } from "@s2script/sdk/plugin";
import { Database } from "@s2script/sdk/db";
import { config } from "@s2script/sdk/config";
import type { GangsApi } from "../api";
import type { Db } from "./db/db";
import { ensureCoreTables } from "./db/schema";
import { GangsRepo } from "./db/gangs.repo";
import { PlayersRepo } from "./db/players.repo";
import { RanksRepo } from "./db/ranks.repo";
import { StatStore } from "./db/instance.repo";
import { PlayerManager } from "./managers/player-manager";
import { RankManager } from "./managers/rank-manager";
import { GangManager } from "./managers/gang-manager";
import { StatManager } from "./managers/stat-manager";
import { buildGangsApi } from "./api/impl";
import type { EmitFn, GangEvents } from "./api/events";
import { makeMessages } from "./messages";
import { runGangCommand } from "./commands/gang";
import { INVITATION_STAT, PENDING_STAT, DOOR_POLICY_STAT } from "./commands/handlers";

export default plugin(async (ctx) => {
  const prefix = config.getString("table_prefix") || "gang";
  const connName = config.getString("db_connection") || "default";
  const tag = config.getString("chat_tag") || "Gangs>";

  const db: Db = await Database.open(connName);
  await ensureCoreTables(db, prefix);

  const players = new PlayerManager(new PlayersRepo(db, prefix));
  const ranks = new RankManager(new RanksRepo(db, prefix), players);
  const gangs = new GangManager(new GangsRepo(db, prefix), players, ranks);
  const stats = new StatManager(
    new StatStore(db, `${prefix}_gang_stats`, "GangId", "INTEGER"),
    new StatStore(db, `${prefix}_player_stats`, "Steam", "BIGINT"),
  );

  // publish/emit are wired via a forwarder so the API can emit through the handle it helps create.
  let handle: { emit(event: string, payload: unknown): void } | null = null;
  const emit: EmitFn = <K extends keyof GangEvents>(event: K, payload: GangEvents[K]) =>
    handle?.emit(event, payload);

  const api: GangsApi = buildGangsApi({ gangs, players, ranks, stats }, emit);
  api.stats.register(INVITATION_STAT);
  api.stats.register(PENDING_STAT);
  api.stats.register(DOOR_POLICY_STAT);

  handle = ctx.publish<GangsApi>("@gangs/api", api);

  const msg = makeMessages(tag);
  ctx.commands.register("gang", (cmd) => runGangCommand(api, msg, cmd));
});
```

- [ ] **Step 4: Verify the full test suite still passes.** Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Build the plugin.** Run: `npm run build` — Expected: exits 0, produces `dist/gangs.s2sp`. If the build errors on the `api.d.ts` re-export or the `types` location, apply the fallbacks noted in Task 14 Step 3 and Task 17 Step 1, then rebuild.

- [ ] **Step 6: Commit.**
```bash
git add src/plugin.ts src/commands/gang.ts package.json
git commit -m "feat: wire plugin, publish @gangs/api, register /gang command"
```

- [ ] **Step 7: Manual in-server smoke checklist** (document results in the commit or an issue; requires a CS2 test server):
  1. Drop `dist/gangs.s2sp` into `addons/s2script/plugins/`; confirm it loads (no errors in console).
  2. `/gang create Testers` → success message; `/gang` → shows gang, your rank Owner, 1 member.
  3. Second client: owner `/gang invite <name>`; invitee `/gang pending` shows the gang; `/gang join Testers` → joined.
  4. `/gang members` lists both; `/gang promote <name>` / `/gang demote <name>` adjust rank.
  5. `/gang kick <name>` removes the member; `/gang leave` as a member works; owner `/gang leave` is refused.
  6. `/gang transfer <member>` hands off ownership; old owner is demoted.
  7. `/gang doorpolicy open` then a fresh client `/gang join Testers` without an invite succeeds.
  8. `/gang disband` warns; `/gang disband confirm` deletes the gang.
  9. Re-drop the `.s2sp` (hot reload); confirm gangs persist (data is in SQLite).

---

## Self-Review Notes

- **Spec coverage:** schema (Tasks 4,6,7,8) · dynamic stat tables (8) · Perm/domain (1,2) · managers (9–12) · published API + events + `getMembership` (13,14) · core commands incl. transfer & doorpolicy (16) · config/messages/errors (15,17) · tests throughout · manifest/publish (17). Deferred items (eco/perks/menus/satellites) intentionally excluded.
- **SteamID fidelity** enforced in Task 6 (`CAST(Steam AS TEXT)`, string round-trip test) and used as string everywhere downstream.
- **Boundary/DTO rule** honored: API returns plain objects; events carry plain payloads.
- **Type consistency:** manager method names referenced by `buildGangsApi` (Task 14) match their definitions (Tasks 9–12); stat descriptor ids in handlers (Task 16) match those registered in `plugin.ts` (Task 17).
- **Known verification points** (flagged inline, resolved at build): `api.d.ts` re-export acceptance by `s2s build`; exact location of the `types` manifest key. Both have inline fallbacks.
