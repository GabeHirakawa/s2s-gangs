# Gangs → s2script Port — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorming complete, ready for implementation plan)
**Upstream:** [edgegamers/Gangs](https://github.com/edgegamers/Gangs) (C# / CounterStrikeSharp)
**Target:** [s2script](https://s2script.com) plugin (`@s2script/sdk` `^0.8.0`, `@s2script/cs2` `^0.7.4`)

## Goal

Port the Gangs plugin to s2script as a single `gangs` plugin that:

1. Keeps the **database schema identical** to upstream (same table names and columns).
2. Exposes a **full, faithful public API** other plugins can consume (`ctx.publish("@gangs/api", …)`)
   plus lifecycle events, so satellites (Leaderboard, Raffle, EcoRewards, Coinflip, …) can be built
   against it later without touching core.
3. Ships a **stable prototype** covering the core gang lifecycle. Perks, economy, interactive menus,
   and the satellite plugins are deliberately deferred — the API is designed to accommodate them
   without breaking changes.

Git: initialize a repository and commit directly to `main` (no feature branches) until the prototype
is stable.

## Scope

**Prototype scope: "Core + API only."** The runtime features shipped are the core gang lifecycle;
the *published API* is faithful and complete for what it covers.

**In scope**
- Data layer: `gang_gangs`, `gang_players`, `gang_ranks`, and the dynamic per-stat instance tables.
- Managers: gang / player / rank / stat with upstream semantics.
- Published `@gangs/api` object (namespaced) + lifecycle events.
- Core `/gang` commands (see §6).
- Stats used by the core loop: `gang_invitation`, `pending_invitation`, `gang_door_policy`.
- Dev test toolchain (vitest + better-sqlite3) with logic tests against real SQLite.

**Deferred (API leaves room; not wired yet)**
- Economy (`IEcoManager`): balance / deposit / purchase.
- Perks: colored smoke, gang chat, name display, capacity, MOTD.
- Interactive menus (upstream `IMenuManager` / paged menus) — prototype is commands-only.
- Satellite plugins: Leaderboard, Raffle, EcoRewards, StatsTracker, Coinflip.
- Full `lang/en.json` translation porting (prototype uses a self-contained `messages.ts`).

## Decisions Log (from brainstorming)

| Decision | Choice |
|---|---|
| Prototype scope | Core + API only |
| API faithfulness | Idiomatic TS, same concepts/names (not a literal C# mirror) |
| Architecture | Faithful layered port, single plugin (Approach A) |
| Manager caching | Deferred (managers hit DB directly; add later behind the interface) |
| Write serialization | No explicit mutex; rely on single-threaded event loop + `lastInsertId` |
| Invite targets | Online players only |
| `/gang transfer` | Included |
| Messages | Self-contained `messages.ts` now; full lang porting later |
| Test toolchain | vitest + better-sqlite3, logic tests against real in-memory SQLite |

## 1. Architecture & Module Layout

Single `gangs` plugin. `src/` mirrors upstream's layers so the C# is easy to cross-reference.

```
src/
  plugin.ts            # factory: open DB, build managers, publish @gangs/api, register commands
  domain/
    types.ts           # Gang, GangPlayer, GangRank, Membership, DoorPolicy (plain data DTOs)
    perm.ts            # Perm bitflags + helpers (hasPerm, describe, DEFAULT_RANKS)
  db/
    connection.ts      # Database.open() wrapper + table-prefix/connection config
    schema.ts          # CREATE TABLE IF NOT EXISTS for gangs / players / ranks
    gangs.repo.ts      # row CRUD for gang_gangs
    players.repo.ts    # row CRUD for gang_players (SteamID as string; CAST on read)
    ranks.repo.ts      # row CRUD for gang_ranks
    instance.repo.ts   # dynamic per-stat tables (AbstractInstanceManager analog)
  managers/
    gang-manager.ts    # create/delete cascade, name update
    player-manager.ts  # get-or-create, members, find-in-gang, membership bundle
    rank-manager.ts    # default ranks, delete strategies, rank hierarchy helpers
    stat-manager.ts    # register stats + get/set/remove on gang|player instances
  api/
    impl.ts            # wires managers into the published object + emits events
    events.ts          # event name/payload definitions
  commands/
    gang.ts            # /gang dispatcher
    *.ts               # one handler (group) per subcommand
  messages.ts          # self-contained English strings + chat-color formatting
api.d.ts               # published contract (manifest `types`); the single source of the
                       # public interface — internal code imports its types from here
```

**Boundary constraint (critical):** values crossing the `publish`/`use` boundary — including forwarded
event payloads — are **structured-copied (JSON, EntityRef-aware), never live references**. Therefore:
- The public API traffics in **plain data DTOs** with no methods; behavior lives in API methods and
  free functions.
- `Perm` crosses as a plain number (bitfield). SteamID64 crosses as a **string**.
- API methods return `null` / `false` / `[]` on expected failure, never a live handle.

## 2. Data Layer & Schema

SQLite is s2script's built-in driver; opened via `Database.open(db_connection)`. Tables are created
verbatim from upstream. Table prefix defaults to `gang` (configurable), producing identical names.

### Fixed tables

```sql
gang_gangs   (GangId INTEGER PRIMARY KEY, Name VARCHAR(255) NOT NULL)
gang_players (Steam BIGINT PRIMARY KEY, Name VARCHAR(255), GangId INT, GangRank INT)
gang_ranks   (GangId INT, Rank INT, Name VARCHAR(255), Permissions INT,
              PRIMARY KEY (GangId, Rank))
```

### Dynamic per-stat instance tables

One table per registered stat, exactly as upstream:
- `gang_gang_stats_<statId>` keyed by `GangId`; `gang_player_stats_<statId>` keyed by `Steam`.
- **Scalar stat** → a single column named `<statId>` (e.g. `gang_door_policy INT`).
- **Record stat** → one column per field (e.g. `gang_invitation` →
  `InvitedSteams, InviterSteams, RequestedSteams, Dates VARCHAR(255), MaxAmo INT`).
- Upsert via `INSERT … ON CONFLICT(<pk>) DO UPDATE SET …` (SQLite form of upstream's
  `ON DUPLICATE KEY UPDATE`).
- Tables created lazily on first use, matching upstream.

### Replacing C# reflection with an explicit column descriptor

Upstream derives stat columns by reflecting the value type at runtime. TS has no equivalent, so a stat
is registered with an explicit **column descriptor** — the one deliberate divergence, producing
byte-identical table shapes:

```ts
// scalar
stats.register({ id: "gang_door_policy", scope: "gang", kind: "scalar", column: "INT" });

// record
stats.register({
  id: "gang_invitation", scope: "gang", kind: "record",
  columns: {
    InvitedSteams: "VARCHAR(255)", InviterSteams: "VARCHAR(255)",
    RequestedSteams: "VARCHAR(255)", Dates: "VARCHAR(255)", MaxAmo: "INT",
  },
});
```

### SteamID64 fidelity

Stored in `Steam BIGINT` unchanged, but always crosses the DB/API boundary as a **string**. Reads use
`SELECT CAST(Steam AS TEXT) AS Steam …` so a 64-bit ID never round-trips through a lossy JS number
(JS numbers lose precision above 2^53; SteamID64s exceed that). Inside stat columns, steam lists stay
comma-joined strings exactly as upstream (`InvitedSteams = "7656…,7656…"`).

### Prototype stat usage

- `gang_invitation` (gang record): outgoing invites/requests. Fields as above.
- `pending_invitation` (player record): `InvitingGangs` (comma-joined gang IDs).
- `gang_door_policy` (gang scalar): `DoorPolicy` int, default `REQUEST_ONLY`.

## 3. Domain Types & Permissions

Plain data DTOs (no methods — they cross the API boundary), faithful to upstream field names/semantics.

```ts
interface Gang       { gangId: number; name: string; }
interface GangPlayer { steam: string; name: string | null;
                       gangId: number | null; gangRank: number | null; }
interface GangRank   { rank: number; name: string; permissions: number; } // permissions = Perm bits
interface Membership { player: GangPlayer; gang: Gang; rank: GangRank; }
enum DoorPolicy      { REQUEST_ONLY, INVITE_ONLY, OPEN }         // stored int, order matches upstream
enum DeleteStrat     { CANCEL, DEMOTE_FAIL, DEMOTE_KICK }        // rank-deletion strategy (upstream)
```

Invariants preserved from upstream:
- A player's `gangId` and `gangRank` are **both null or both set**.
- Rank ordering: **lower number = higher rank; 0 = owner**.

### `Perm` bitflags

Identical values to the C# `[Flags] enum` so the stored `Permissions INT` is wire-compatible:

Base flags (single bits):

```ts
const BIT = {
  NONE: 0,
  INVITE_OTHERS: 1 << 0, KICK_OTHERS: 1 << 1, BANK_DEPOSIT: 1 << 2, BANK_WITHDRAW: 1 << 3,
  PROMOTE_OTHERS: 1 << 4, DEMOTE_OTHERS: 1 << 5, PURCHASE_PERKS: 1 << 6, MANAGE_PERKS: 1 << 7,
  MANAGE_RANKS: 1 << 8, CREATE_RANKS: 1 << 9, VIEW_MEMBER_DETAILS: 1 << 12, SEND_GANG_CHAT: 1 << 14,
};
```

Composed flags — computed exactly as upstream (values written out so `Permissions INT` is
wire-compatible):

- `MANAGE_INVITES = (1 << 13) | INVITE_OTHERS`
- `ADMINISTRATOR  = (1 << 10) | INVITE_OTHERS | KICK_OTHERS | BANK_DEPOSIT | BANK_WITHDRAW |`
  `PROMOTE_OTHERS | DEMOTE_OTHERS | PURCHASE_PERKS | MANAGE_PERKS | MANAGE_RANKS | CREATE_RANKS |`
  `VIEW_MEMBER_DETAILS | MANAGE_INVITES | SEND_GANG_CHAT`
- `OWNER          = (1 << 11) | ADMINISTRATOR`

The final `Perm` object is a flat `const` of base + composed values. Highest bit used is `1 << 14`, so
the whole enum fits safely in a JS number and in `Permissions INT`.

Helpers replace C# instance methods:
- `hasPerm(perms, flag): boolean`
- `describe(perms): string`
- `DEFAULT_RANKS`: Owner 0 / Co-Owner 10 / Manager 30 / Officer 50 / Member 100, with the exact
  permission sets from upstream `AssignDefaultRanks`.

## 4. Managers (Service Semantics)

Four managers hold the real behavior. Each takes its repo(s) as constructor deps and is unit-testable
against real in-memory SQLite. **No caching** in the prototype (add later behind the same interface).
**No explicit write mutex** — rely on s2script's single-threaded event loop; use `execute()`'s
`lastInsertId` for new `GangId` (removes upstream's `SELECT MAX(GangId)` race).

**PlayerManager**
- `getPlayer(steam, create=true)` — get-or-create like upstream.
- `createPlayer(steam, name?)`, `getAllPlayers()`, `getMembers(gangId)` (ordered by rank).
- `findPlayerInGang(gangId, query)` — steam/name match, single-match rule.
- `getMembership(steam)` — resolves `{ player, gang, rank }` or `null`.
- `updatePlayer(player)` — enforces the gangId/gangRank both-or-neither invariant.
- `deletePlayer(steam)`.

**RankManager**
- `getRanks/getRank`, `addRank`, `createRank`, `updateRank` (blocks `OWNER` on non-0 and negative ranks).
- `deleteRank(gang, rank, strat)` — the three upstream strategies `CANCEL` / `DEMOTE_FAIL` /
  `DEMOTE_KICK`, including member-reassignment cascade.
- `deleteAllRanks(gang)`, `assignDefaultRanks(gang)`.
- Hierarchy helpers: `getJoinRank`, `getHigherRank`, `getLowerRank`, `getRankNeeded`, `checkRank`.

**GangManager**
- `getGangs`, `getGang(id)`, `getGang(steam)`.
- `createGang(name, ownerSteam)` — create gang → assign default ranks → set owner to gang/rank 0
  (exact upstream ordering); new id from `lastInsertId`.
- `updateGang(gang)` — name.
- `deleteGang(id)` — clear all members' gangId/gangRank, delete all ranks, then the gang row.

**StatManager**
- `register(descriptor)`, and scoped `getForGang/setForGang/removeFromGang` +
  `getForPlayer/setForPlayer/removeFromPlayer`, delegating to `instance.repo`. Records serialize to
  columns; scalars to the single column.

## 5. Published API & Events

One object published as `@gangs/api` (`ctx.publish`), namespaced to mirror the managers. All methods
are async and traffic in plain DTOs.

```ts
interface GangsApi {
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
    create(steam: string, name?: string): Promise<GangPlayer>;
    getAll(): Promise<GangPlayer[]>;
    getMembers(gangId: number): Promise<GangPlayer[]>;
    findInGang(gangId: number, query: string): Promise<GangPlayer | null>;
    getMembership(steam: string): Promise<Membership | null>;
    update(p: GangPlayer): Promise<boolean>;
    delete(steam: string): Promise<boolean>;
  };
  members: {                     // membership mutations that EMIT lifecycle events
    add(gangId: number, steam: string, rank: number): Promise<boolean>;       // member_joined
    remove(steam: string, reason: "leave"|"kick"|"disband"): Promise<boolean>;// member_left
    setRank(steam: string, newRank: number): Promise<boolean>;                // member_rank_changed
  };
  invites: {
    create(gangId: number, inviter: string, invited: string, nowSec: number): Promise<boolean>; // invite_created
    revoke(gangId: number, invited: string): Promise<boolean>;               // invite_revoked
    outgoing(gangId: number): Promise<string[]>;
    pending(steam: string): Promise<number[]>;
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

Three shapes for "a member's gang," each for a different need:
- `gangs.getByMember(steam)` → just the `Gang` (faithful to upstream `IGangManager.GetGang(ulong)`).
- `players.get(steam)` → the `GangPlayer` (raw `gangId`/`gangRank`; low-level accessor).
- `players.getMembership(steam)` → resolved `{ player, gang, rank }` bundle (convenience).

### Consumption model

```ts
// consumer manifest: pluginDependencies: { "@gangs/api": "^0.1.0" }  (hard)
//                or  optionalPluginDependencies: { … }               (soft → ctx.tryUse)
const gangs = ctx.use<GangsApi>("@gangs/api");
gangs.on("member_joined", (e) => { /* react */ });
const gang = await gangs.gangs.getByMember(steamId);
```

### Events (via publish handle `.emit`, consumed via `api.on`)

Membership/invite changes go through the `members`/`invites` methods (and `gangs.delete`), which is what fires these events — for command handlers and external consumers alike. Raw `players.update` does not emit; command handlers route through `members`/`invites`.

| event | payload |
|---|---|
| `gang_created` | `{ gangId, name, ownerSteam }` |
| `gang_deleted` | `{ gangId }` |
| `gang_renamed` | `{ gangId, name }` |
| `member_joined` | `{ gangId, steam, rank }` |
| `member_left` | `{ gangId, steam, reason: "leave" \| "kick" \| "disband" }` |
| `member_rank_changed` | `{ gangId, steam, oldRank, newRank }` |
| `invite_created` | `{ gangId, inviter, invited }` |
| `invite_revoked` | `{ gangId, invited }` |

### Manifest

`package.json` `s2script` block:
- `publishes: "self"` (s2script enforces one published interface per plugin — the whole API rides
  under `@gangs/api`).
- `types: "api.d.ts"` — the published contract.
- version `0.1.0`.

`Perm` bit values are a documented, stable part of the contract (exported for consumers). Deferred
namespaces (`eco`, `perks`) are simply absent from the contract now and added later without breaking
existing consumers.

## 6. Commands (Core `/gang` Loop)

> **Amended 2026-07-24:** the original single-`/gang`-command-plus-dispatcher design was replaced with
> **individual `sm_`-prefixed commands** (SourceMod convention). Each row below is registered as its own
> engine command via `registerGangCommands` from a `COMMANDS` registry — `sm_gang` (info),
> `sm_gang_create`, `sm_gang_invite`, `sm_gang_join`, … `sm_gang_help`. Chat `!gang_create` resolves to
> `sm_gang_create`. There is no central subcommand dispatcher. Read `subcommand X` below as the command
> `sm_gang_X`. The handler bodies, gating, and emitted events are unchanged.

Each command is a small handler taking a `CmdCtx`. Caller identity: `Clients.fromSlot(cmd.callerSlot)?.steamId`;
server console (`-1`) → "players only." In-gang gating happens inside handlers via
`ranks.checkPermission(steam, Perm.X)` (not SM admin flags).

| subcommand | behavior | perm gate | emits |
|---|---|---|---|
| `/gang` (no args) | show your gang (name, your rank, member count) or the "not in a gang" hint | — | — |
| `create <name>` | create gang; caller becomes owner (rank 0) | not in a gang | `gang_created` |
| `invite <player>` | invite an online player; writes `gang_invitation` + target `pending_invitation` | `INVITE_OTHERS`/`MANAGE_INVITES` | `invite_created` |
| `invites` | list your gang's outgoing invites | member | — |
| `pending` | list gangs that invited you | — | — |
| `join <gang>` | join respecting door policy (invited / open / request) | — | `member_joined` |
| `leave` | leave your gang (owner must transfer/disband first) | member | `member_left`(leave) |
| `kick <player>` | kick a lower-ranked member | `KICK_OTHERS` | `member_left`(kick) |
| `promote <player>` / `demote <player>` | move a member up/down the rank ladder | `PROMOTE_OTHERS`/`DEMOTE_OTHERS` | `member_rank_changed` |
| `transfer <member>` | owner hands off rank 0 to a member | `OWNER` | `member_rank_changed` ×2 |
| `members` | list members with ranks | member | — |
| `doorpolicy <open\|invite\|request>` | set the gang's join policy | `MANAGE_RANKS` | — |
| `disband [confirm]` | owner-only, two-step confirm; deletes gang | `OWNER` | `gang_deleted` + `member_left`(disband)×N |
| `help` | usage list | — | — |

Invite acceptance goes through `join`, matching upstream. Invites target **online players only**
(resolved by name or SteamID among connected clients).

**Door policy in v0.1:** `OPEN` lets anyone `join`; `INVITE_ONLY` and `REQUEST_ONLY` both require a
standing invite to join. The request-to-join flow (a player asking a closed gang to let them in, and
an officer approving) is **deferred** — the `RequestedSteams` column exists in the schema for
forward-compatibility but is not yet written. `doorpolicy` still accepts `request` (stored), it just
behaves like `invite` until the request flow lands.

## 7. Config, Translations, Error Handling

**Config** (declared under `s2script.config`, read via `config.getInt/getString`, live-reload via
`ctx.config.onChange`):
- `table_prefix` (default `"gang"`) — keeps table names identical to upstream.
- `db_connection` (default `"default"`) — which named connection `Database.open()` uses.
- `currency_name` (default `"credits"`), `chat_tag` (default `"Gangs>"`).

A change to `db_connection` requires a plugin reload to take effect (noted to the user); other values
re-read live.

**Messages:** a self-contained `messages.ts` (English, formatted with `@s2script/sdk/chat` colors)
carrying the ~30 strings the core commands need, wording matched to upstream where easy. Full
`lang/en.json` porting (and `@s2script/translations` integration) is a later step.

**Error handling** (faithful to upstream conventions):
- Expected failures return `null` / `false` / `[]` (e.g. `createGang` → `null`), never throw — so
  consumers across the boundary get predictable shapes.
- Genuine invariant violations throw (e.g. `gangId` set with `gangRank` null), matching upstream's
  `InvalidOperationException`.
- Command handlers wrap calls, reply a generic error, and `console.log` the detail.
- Lazy stat tables: a read against a not-yet-created stat table returns the default/empty value
  (upstream catches "no such table").

## 8. Testing

The `@s2script/*` packages are types-only (impl injected at load), so the real `Database` cannot be
imported outside the server.

- **Logic tests (bulk of correctness):** repos/managers depend only on a tiny `Db` interface
  (`query`/`execute`), backed in tests by **real in-memory SQLite** (better-sqlite3) so the actual SQL
  (`ON CONFLICT`, `CAST AS TEXT`, dynamic stat tables) is exercised — same SQL in tests and
  production. Runner: **vitest**. Coverage targets: rank-delete cascades, default-rank assignment,
  perm bit math, invite/pending serialization, create/disband flows, the gangId/gangRank invariant,
  and membership resolution.
- **In-server smoke checklist:** a short documented manual pass — build `.s2sp`, drop on a test
  server, run each `/gang` subcommand — for the command/slot/chat wiring that only exists at runtime.

Add `vitest` and `better-sqlite3` as devDependencies. Wire an adapter so the same repos run on the
injected `Database` in production and on better-sqlite3 in tests.

## Out of Scope / Future Work

Each becomes its own spec → plan → implementation cycle, consuming `@gangs/api`:
- Economy (`eco` namespace) + balance/deposit/purchase commands.
- Perks (colored smoke, gang chat, name display, capacity, MOTD) via the stat/perk registration path.
- Interactive menus.
- Satellite plugins: Leaderboard, Raffle, EcoRewards, StatsTracker, Coinflip.
- Full translation porting.
- MySQL backend parity (if s2script gains a MySQL driver).
