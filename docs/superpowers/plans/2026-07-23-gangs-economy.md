# Gangs Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a self-contained credits economy to the existing `gangs` plugin — `eco` namespace on `@gangs/api`, credit events, and `/gang balance` / `/gang deposit` / admin `/credits` — backed by the upstream `gang_native_balance` scalar stat.

**Architecture:** Extends the shipped gangs core. Credits live in the `gang_native_balance` scalar-int stat (player scope + gang-bank scope). A new `EcoManager` holds the balance/purchase/grant logic (built inside `buildGangsApi`); the `eco` namespace delegates to it and emits credit events.

**Tech Stack:** TypeScript, `@s2script/sdk`, SQLite. Dev: existing vitest + better-sqlite3 harness.

## Global Constraints

- **This EXTENDS an existing codebase.** Read each file before modifying; preserve existing exports, style, and signatures. Do not restructure unrelated code.
- Balance stat id is exactly **`gang_native_balance`** (scalar `INT`), registered for BOTH `gang` and `player` scopes. Tables: `<prefix>_gang_stats_gang_native_balance(GangId, gang_native_balance INT)` and `<prefix>_player_stats_gang_native_balance(Steam, gang_native_balance INT)`.
- Credits are JS-safe integers (not SteamID64) — plain `number` across the boundary.
- `src` stays within `lib: ES2020` (no `Array.at`/`findLast`/etc.).
- Faithful semantics: gang bank counts toward a member's balance ONLY if they have `Perm.BANK_WITHDRAW`; `tryPurchase` pulls from the gang bank first, then the player; an unaffordable purchase writes nothing and returns the negative hypothetical remaining.
- Existing signatures to consume: `StatManager.getForGang<T>/setForGang<T>/getForPlayer<T>/setForPlayer<T>`, `PlayerManager.getPlayer(steam, create?)`, `RankManager.getRank(gangId, rank)`, `Perm`/`hasPerm` from `src/domain/perm`, `buildGangsApi(m: Managers, emit: EmitFn)` where `Managers = { gangs, players, ranks, stats }`, `CmdCtx` from `src/commands/ctx`, `handlers`/`dispatch` in `src/commands/handlers.ts`, `runGangCommand` in `src/commands/gang.ts`, `ctx.commands.registerAdmin(name, flags, handler)`.
- Tests under `test/`; run `npm test` (full) green + `npx tsc --noEmit -p tsconfig.json` clean before each commit.

---

## Task 1: Balance stat descriptors

**Files:** Create `src/eco/balance.ts`; Test `test/eco/balance.test.ts`

**Interfaces — Produces:**
- `BALANCE_STAT_ID = "gang_native_balance"`
- `GANG_BALANCE_STAT: StatDescriptor` (scope `gang`, scalar `INT`)
- `PLAYER_BALANCE_STAT: StatDescriptor` (scope `player`, scalar `INT`)

- [ ] **Step 1: Failing test** — `test/eco/balance.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { BALANCE_STAT_ID, GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";

describe("balance descriptors", () => {
  it("share the upstream stat id and are scalar INT per scope", () => {
    expect(BALANCE_STAT_ID).toBe("gang_native_balance");
    expect(GANG_BALANCE_STAT).toEqual({ id: "gang_native_balance", scope: "gang", kind: "scalar", column: "INT" });
    expect(PLAYER_BALANCE_STAT).toEqual({ id: "gang_native_balance", scope: "player", kind: "scalar", column: "INT" });
  });
});
```

- [ ] **Step 2: Run — fails.** `npm test test/eco/balance.test.ts`

- [ ] **Step 3: Implement** — `src/eco/balance.ts`:
```ts
import type { StatDescriptor } from "../db/instance.repo";

/** Upstream BalanceStat.STAT_ID — one id, used for both player wallet and gang bank. */
export const BALANCE_STAT_ID = "gang_native_balance";

export const GANG_BALANCE_STAT: StatDescriptor = {
  id: BALANCE_STAT_ID, scope: "gang", kind: "scalar", column: "INT",
};
export const PLAYER_BALANCE_STAT: StatDescriptor = {
  id: BALANCE_STAT_ID, scope: "player", kind: "scalar", column: "INT",
};
```

- [ ] **Step 4: Run — passes.** `npm test test/eco/balance.test.ts`
- [ ] **Step 5: Commit.** `git add src/eco/balance.ts test/eco/balance.test.ts && git commit -m "feat(eco): balance stat descriptors"`

---

## Task 2: EcoManager

**Files:** Create `src/eco/eco-manager.ts`; Test `test/eco/eco-manager.test.ts`

**Interfaces:**
- Consumes: `StatManager`, `PlayerManager`, `RankManager`, `Perm`/`hasPerm`, `BALANCE_STAT_ID` (Task 1).
- Produces: `interface CreditsEmit { player(steam, balance, delta, reason): void; gang(gangId, balance, delta, reason): void }` and `class EcoManager` with `constructor(stats, players, ranks, emit?)` and async `getBalance(steam, excludeGangCredits?)`, `getGangBalance(gangId)`, `canAfford(steam, cost, excludeGangCredits?)`, `grantPlayer(steam, amount, reason?)`, `grantGang(gangId, amount, reason?)`, `tryPurchase(steam, cost, excludeGangCredits?)`.

- [ ] **Step 1: Failing test** — `test/eco/eco-manager.test.ts`:
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
import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";
import { EcoManager } from "../../src/eco/eco-manager";

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
  stats.register(GANG_BALANCE_STAT); stats.register(PLAYER_BALANCE_STAT);
  const eco = new EcoManager(stats, players, ranks);
  return { players, gangs, eco };
}

describe("EcoManager", () => {
  it("grantPlayer/grantGang accumulate and read back", async () => {
    const { players, eco } = await harness();
    await players.createPlayer("1", "A");
    expect(await eco.grantPlayer("1", 100)).toBe(100);
    expect(await eco.getBalance("1")).toBe(100);
  });

  it("owner (has BANK_WITHDRAW) sees gang bank in total; a member without it does not", async () => {
    const { players, gangs, eco } = await harness();
    await players.createPlayer("owner", "O");
    const gang = await gangs.createGang("G", "owner"); // owner rank 0 has OWNER (incl BANK_WITHDRAW)
    await eco.grantGang(gang!.gangId, 500);
    await eco.grantPlayer("owner", 50);
    expect(await eco.getBalance("owner")).toBe(550);        // 50 + 500 bank
    expect(await eco.getBalance("owner", true)).toBe(50);   // exclude gang
    // a plain Member (rank 100) lacks BANK_WITHDRAW
    await players.createPlayer("m", "M");
    await players.updatePlayer({ steam: "m", name: "M", gangId: gang!.gangId, gangRank: 100 });
    await eco.grantPlayer("m", 20);
    expect(await eco.getBalance("m")).toBe(20);             // bank NOT counted
  });

  it("tryPurchase pulls from gang bank first, then player; unaffordable is a no-op", async () => {
    const { players, gangs, eco } = await harness();
    await players.createPlayer("owner", "O");
    const gang = await gangs.createGang("G", "owner");
    await eco.grantGang(gang!.gangId, 300);
    await eco.grantPlayer("owner", 100);              // total 400
    const remaining = await eco.tryPurchase("owner", 350);
    expect(remaining).toBe(50);
    expect(await eco.getGangBalance(gang!.gangId)).toBe(0);   // 300 bank spent first
    expect(await eco.getBalance("owner", true)).toBe(50);     // then 50 from player
    // unaffordable: no writes
    const before = await eco.getBalance("owner");
    expect(await eco.tryPurchase("owner", 9999)).toBeLessThan(0);
    expect(await eco.getBalance("owner")).toBe(before);
  });
});
```

- [ ] **Step 2: Run — fails.** `npm test test/eco/eco-manager.test.ts`

- [ ] **Step 3: Implement** — `src/eco/eco-manager.ts`:
```ts
import type { StatManager } from "../managers/stat-manager";
import type { PlayerManager } from "../managers/player-manager";
import type { RankManager } from "../managers/rank-manager";
import { Perm, hasPerm } from "../domain/perm";
import { BALANCE_STAT_ID } from "./balance";

/** Sink for credit-change notifications; buildGangsApi adapts this to the publish emitter. */
export interface CreditsEmit {
  player(steam: string, balance: number, delta: number, reason: string | null): void;
  gang(gangId: number, balance: number, delta: number, reason: string | null): void;
}

export class EcoManager {
  constructor(
    private stats: StatManager,
    private players: PlayerManager,
    private ranks: RankManager,
    private emit?: CreditsEmit,
  ) {}

  async getGangBalance(gangId: number): Promise<number> {
    return (await this.stats.getForGang<number>(gangId, BALANCE_STAT_ID)) ?? 0;
  }

  private async playerBalance(steam: string): Promise<number> {
    return (await this.stats.getForPlayer<number>(steam, BALANCE_STAT_ID)) ?? 0;
  }

  /** [playerOnly, total]; total includes the gang bank iff the member has BANK_WITHDRAW. */
  private async balances(steam: string): Promise<[number, number]> {
    const player = await this.playerBalance(steam);
    const gp = await this.players.getPlayer(steam, false);
    if (!gp || gp.gangId === null || gp.gangRank === null) return [player, player];
    const rank = await this.ranks.getRank(gp.gangId, gp.gangRank);
    if (!rank || !hasPerm(rank.permissions, Perm.BANK_WITHDRAW)) return [player, player];
    const bank = await this.getGangBalance(gp.gangId);
    return [player, player + bank];
  }

  async getBalance(steam: string, excludeGangCredits = false): Promise<number> {
    const [player, total] = await this.balances(steam);
    return excludeGangCredits ? player : total;
  }

  async canAfford(steam: string, cost: number, excludeGangCredits = false): Promise<boolean> {
    return (await this.getBalance(steam, excludeGangCredits)) >= cost;
  }

  async grantPlayer(steam: string, amount: number, reason: string | null = null): Promise<number> {
    const next = (await this.playerBalance(steam)) + amount;
    await this.stats.setForPlayer(steam, BALANCE_STAT_ID, next);
    this.emit?.player(steam, next, amount, reason);
    return next;
  }

  async grantGang(gangId: number, amount: number, reason: string | null = null): Promise<number> {
    const next = (await this.getGangBalance(gangId)) + amount;
    await this.stats.setForGang(gangId, BALANCE_STAT_ID, next);
    this.emit?.gang(gangId, next, amount, reason);
    return next;
  }

  /** Remaining balance after the purchase; negative and no-op if unaffordable. Gang bank first. */
  async tryPurchase(steam: string, cost: number, excludeGangCredits = false): Promise<number> {
    const [player, total] = await this.balances(steam);
    const remaining = (excludeGangCredits ? player : total) - cost;
    if (remaining < 0) return remaining;

    let due = cost;
    const gp = await this.players.getPlayer(steam, false);
    const gangBank = total - player; // 0 unless the member can access the bank
    if (!excludeGangCredits && gp && gp.gangId !== null && gangBank > 0) {
      const fromGang = Math.min(gangBank, due);
      await this.grantGang(gp.gangId, -fromGang, "purchase");
      due -= fromGang;
    }
    if (due > 0) await this.grantPlayer(steam, -due, "purchase");
    return remaining;
  }
}
```

- [ ] **Step 4: Run — passes.** `npm test test/eco/eco-manager.test.ts`
- [ ] **Step 5: Commit.** `git add src/eco/eco-manager.ts test/eco/eco-manager.test.ts && git commit -m "feat(eco): EcoManager balance/purchase/grant"`

---

## Task 3: Credit events + API contract

**Files:** Modify `src/api/events.ts`, `api.d.ts`; Test `test/api/events.test.ts`

**Interfaces — Produces:** `GangEvents.player_credits_changed` + `GangEvents.gang_credits_changed`; the `eco` namespace on the `GangsApi` contract.

- [ ] **Step 1: Extend the events test** — append to `test/api/events.test.ts`'s existing describe (or add a new one):
```ts
import { GANG_EVENTS } from "../../src/api/events";
// add:
it("includes the two credit events", () => {
  expect(GANG_EVENTS).toContain("player_credits_changed");
  expect(GANG_EVENTS).toContain("gang_credits_changed");
});
```

- [ ] **Step 2: Run — fails.** `npm test test/api/events.test.ts`

- [ ] **Step 3: Implement events** — in `src/api/events.ts`, add to the `GangEvents` interface:
```ts
  player_credits_changed: { steam: string; balance: number; delta: number; reason: string | null };
  gang_credits_changed: { gangId: number; balance: number; delta: number; reason: string | null };
```
and append both names to the `GANG_EVENTS` array.

- [ ] **Step 4: Extend the contract** — in `api.d.ts`, add an `eco` namespace to the `GangsApi` interface (e.g. after `stats`):
```ts
  eco: {
    getBalance(steam: string, excludeGangCredits?: boolean): Promise<number>;
    getGangBalance(gangId: number): Promise<number>;
    canAfford(steam: string, cost: number, excludeGangCredits?: boolean): Promise<boolean>;
    tryPurchase(steam: string, cost: number, opts?: { excludeGangCredits?: boolean }): Promise<number>;
    grantPlayer(steam: string, amount: number, reason?: string): Promise<number>;
    grantGang(gangId: number, amount: number, reason?: string): Promise<number>;
  };
```

- [ ] **Step 5: Run — passes.** `npm test test/api/events.test.ts` and `npx tsc --noEmit -p tsconfig.json` (contract change compiles).
- [ ] **Step 6: Commit.** `git add src/api/events.ts api.d.ts test/api/events.test.ts && git commit -m "feat(eco): credit events + eco API contract"`

---

## Task 4: eco namespace in buildGangsApi

**Files:** Modify `src/api/impl.ts`; Test `test/api/eco.test.ts`

**Interfaces:** Consumes `EcoManager` (Task 2), `EmitFn`, the `eco` contract (Task 3). Produces the runtime `eco` namespace, constructing an `EcoManager` inside `buildGangsApi` wired to emit `player_credits_changed`/`gang_credits_changed`.

- [ ] **Step 1: Failing test** — `test/api/eco.test.ts`:
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
import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";
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
  const a = buildGangsApi({ gangs, players, ranks, stats }, emit);
  a.stats.register(GANG_BALANCE_STAT); a.stats.register(PLAYER_BALANCE_STAT);
  return { a, players, events };
}

describe("api.eco", () => {
  it("grantPlayer emits player_credits_changed with delta and new balance", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("1", "A");
    expect(await a.eco.grantPlayer("1", 75, "test")).toBe(75);
    expect(events).toContainEqual(["player_credits_changed", { steam: "1", balance: 75, delta: 75, reason: "test" }]);
  });
  it("grantGang emits gang_credits_changed", async () => {
    const { a, players, events } = await api();
    await players.createPlayer("owner", "O");
    await a.gangs.create("G", "owner");
    await a.eco.grantGang(1, 200, "seed");
    expect(events).toContainEqual(["gang_credits_changed", { gangId: 1, balance: 200, delta: 200, reason: "seed" }]);
  });
});
```

- [ ] **Step 2: Run — fails.** `npm test test/api/eco.test.ts`

- [ ] **Step 3: Implement** — in `src/api/impl.ts`: add `import { EcoManager } from "../eco/eco-manager";` at the top. Inside `buildGangsApi`, before the `return {`, construct:
```ts
  const eco = new EcoManager(m.stats, m.players, m.ranks, {
    player: (steam, balance, delta, reason) => emit("player_credits_changed", { steam, balance, delta, reason }),
    gang: (gangId, balance, delta, reason) => emit("gang_credits_changed", { gangId, balance, delta, reason }),
  });
```
Then add the `eco` namespace to the returned object (e.g. after `stats`):
```ts
    eco: {
      getBalance: (steam, excludeGangCredits) => eco.getBalance(steam, excludeGangCredits),
      getGangBalance: (gangId) => eco.getGangBalance(gangId),
      canAfford: (steam, cost, excludeGangCredits) => eco.canAfford(steam, cost, excludeGangCredits),
      tryPurchase: (steam, cost, opts) => eco.tryPurchase(steam, cost, opts?.excludeGangCredits ?? false),
      grantPlayer: (steam, amount, reason) => eco.grantPlayer(steam, amount, reason ?? null),
      grantGang: (gangId, amount, reason) => eco.grantGang(gangId, amount, reason ?? null),
    },
```

- [ ] **Step 4: Run — passes.** `npm test test/api/eco.test.ts`
- [ ] **Step 5: Commit.** `git add src/api/impl.ts test/api/eco.test.ts && git commit -m "feat(eco): wire eco namespace into buildGangsApi"`

---

## Task 5: balance/deposit commands + messages

**Files:** Modify `src/messages.ts`, `src/commands/handlers.ts`; Test `test/commands/eco-handlers.test.ts`

**Interfaces:** Adds `cmdBalance`, `cmdDeposit` handlers registered under `balance`/`deposit`; new `Messages` methods. Consumes `api.eco`, `Perm.BANK_DEPOSIT`.

- [ ] **Step 1: Failing test** — `test/commands/eco-handlers.test.ts`: build the same harness as `test/commands/handlers.test.ts` (copy its `harness()` — an api with stats registered) and additionally register `GANG_BALANCE_STAT`/`PLAYER_BALANCE_STAT`, then:
```ts
// (harness identical to handlers.test.ts's, plus:)
//   api.stats.register(GANG_BALANCE_STAT); api.stats.register(PLAYER_BALANCE_STAT);
it("deposit moves personal credits into the gang bank and needs BANK_DEPOSIT", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await dispatch(h.ctx("owner", ["Wolves"]), "create");
  const gang = await h.api.gangs.getByMember("owner");
  await h.api.eco.grantPlayer("owner", 100);
  await dispatch(h.ctx("owner", ["40"]), "deposit");
  expect(await h.api.eco.getGangBalance(gang!.gangId)).toBe(40);
  expect(await h.api.eco.getBalance("owner", true)).toBe(60);
});
it("balance reports personal credits", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await dispatch(h.ctx("owner", ["Wolves"]), "create");
  await h.api.eco.grantPlayer("owner", 30);
  h.replies.length = 0;
  await dispatch(h.ctx("owner", []), "balance");
  expect(h.replies.join("\n")).toContain("30");
});
```

- [ ] **Step 2: Run — fails.** `npm test test/commands/eco-handlers.test.ts`

- [ ] **Step 3: Messages** — in `src/messages.ts`, add to the `Messages` interface and `makeMessages` return object:
```ts
  balance(amount: number): string;
  gangBalance(gang: string, amount: number): string;
  deposited(amount: number): string;
  noCredits(): string;
  cannotAfford(missing: number): string;
  credited(name: string, balance: number): string;
```
Implementations (follow the existing `p(...)` tag style):
```ts
    balance: (amount) => p(`You have ${amount} credits.`),
    gangBalance: (gang, amount) => p(`${gang}'s bank has ${amount} credits.`),
    deposited: (amount) => p(`Deposited ${amount} credits into the gang bank.`),
    noCredits: () => p("You have no credits."),
    cannotAfford: (missing) => p(`You are ${missing} credits short.`),
    credited: (name, balance) => p(`${name} now has ${balance} credits.`),
```

- [ ] **Step 4: Handlers** — in `src/commands/handlers.ts`, add:
```ts
async function cmdBalance(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  ctx.reply(ctx.msg.balance(await ctx.api.eco.getBalance(ctx.steam, true)));
  const membership = await ctx.api.players.getMembership(ctx.steam);
  if (membership) ctx.reply(ctx.msg.gangBalance(membership.gang.name, await ctx.api.eco.getGangBalance(membership.gang.gangId)));
}

async function cmdDeposit(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.BANK_DEPOSIT, "Deposit Money"))) return;
  const raw = (ctx.args[0] ?? "").toLowerCase();
  let amount: number;
  if (raw === "all") {
    amount = await ctx.api.eco.getBalance(me.steam, true);
    if (amount <= 0) { ctx.reply(ctx.msg.noCredits()); return; }
  } else {
    amount = parseInt(raw, 10);
    if (!Number.isInteger(amount) || amount <= 0) { ctx.reply(ctx.msg.usage("/gang deposit <amount|all>")); return; }
  }
  const remaining = await ctx.api.eco.tryPurchase(me.steam, amount, { excludeGangCredits: true });
  if (remaining < 0) { ctx.reply(ctx.msg.cannotAfford(Math.abs(remaining))); return; }
  await ctx.api.eco.grantGang(me.gangId, amount, "deposit");
  ctx.reply(ctx.msg.deposited(amount));
}
```
Register them in the `handlers` map (add `balance: cmdBalance, deposit: cmdDeposit,`) and add `balance, deposit` to the help subcommand list string.

- [ ] **Step 5: Run — passes.** `npm test test/commands/eco-handlers.test.ts`
- [ ] **Step 6: Commit.** `git add src/messages.ts src/commands/handlers.ts test/commands/eco-handlers.test.ts && git commit -m "feat(eco): /gang balance and /gang deposit"`

---

## Task 6: admin /credits command

**Files:** Create `src/commands/credits.ts`; Test `test/commands/credits.test.ts`

**Interfaces — Produces:** `interface CreditsCtx { args: string[]; reply(m: string): void; api: GangsApi; online(q: string): OnlinePlayer[] }`, `runCredits(ctx: CreditsCtx): Promise<void>` (pure/testable), and `runCreditsCommand(api: GangsApi, cmd: CommandInvocation): void` (builds ctx from the runtime + wraps errors).

- [ ] **Step 1: Failing test** — `test/commands/credits.test.ts`:
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
import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";
import { buildGangsApi } from "../../src/api/impl";
import { runCredits } from "../../src/commands/credits";

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
  const a = buildGangsApi({ gangs, players, ranks, stats }, () => {});
  a.stats.register(GANG_BALANCE_STAT); a.stats.register(PLAYER_BALANCE_STAT);
  return a;
}

describe("runCredits", () => {
  it("grants credits to a uniquely-resolved online player", async () => {
    const a = await harness();
    const replies: string[] = [];
    await runCredits({
      args: ["Bob", "250"], reply: (m) => replies.push(m), api: a,
      online: () => [{ steam: "9", name: "Bob" }],
    });
    expect(await a.eco.getBalance("9", true)).toBe(250);
    expect(replies.join("\n")).toContain("250");
  });
  it("rejects a non-integer amount", async () => {
    const a = await harness();
    const replies: string[] = [];
    await runCredits({ args: ["Bob", "xx"], reply: (m) => replies.push(m), api: a, online: () => [{ steam: "9", name: "Bob" }] });
    expect(replies.join("\n").toLowerCase()).toContain("integer");
  });
});
```

- [ ] **Step 2: Run — fails.** `npm test test/commands/credits.test.ts`

- [ ] **Step 3: Implement** — `src/commands/credits.ts`:
```ts
import type { CommandInvocation } from "@s2script/sdk/commands";
import { Clients } from "@s2script/sdk/clients";
import type { GangsApi } from "../../api";
import type { OnlinePlayer } from "./ctx";

export interface CreditsCtx {
  args: string[];
  reply(message: string): void;
  api: GangsApi;
  online(query: string): OnlinePlayer[];
}

export async function runCredits(ctx: CreditsCtx): Promise<void> {
  if (ctx.args.length < 2) { ctx.reply("Usage: /credits <player> <amount> [reason]"); return; }
  const matches = ctx.online(ctx.args[0]);
  if (matches.length !== 1) { ctx.reply(`Could not find a unique player for "${ctx.args[0]}".`); return; }
  const amount = parseInt(ctx.args[1], 10);
  if (!Number.isInteger(amount) || String(amount) !== ctx.args[1].replace(/^\+/, "")) {
    ctx.reply("Amount must be an integer."); return;
  }
  const reason = ctx.args.slice(2).join(" ") || "admin";
  const target = matches[0];
  await ctx.api.players.create(target.steam, target.name);
  const balance = await ctx.api.eco.grantPlayer(target.steam, amount, reason);
  ctx.reply(`${target.name} now has ${balance} credits.`);
}

/** Runtime entry: build CreditsCtx from a CommandInvocation and run, wrapping errors. */
export function runCreditsCommand(api: GangsApi, cmd: CommandInvocation): void {
  const online = (query: string): OnlinePlayer[] => {
    const q = query.toLowerCase();
    return Clients.all()
      .filter((c) => c.isValid() && !c.isBot)
      .map((c) => ({ steam: c.steamId, name: c.name }))
      .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
  };
  const args = cmd.argString.length ? cmd.argString.split(/\s+/) : [];
  runCredits({ args, reply: (m) => cmd.reply(m), api, online }).catch((e) => {
    cmd.reply("An error occurred while running that command.");
    console.log("[gangs] /credits error:", e);
  });
}
```

- [ ] **Step 4: Run — passes.** `npm test test/commands/credits.test.ts`
- [ ] **Step 5: Commit.** `git add src/commands/credits.ts test/commands/credits.test.ts && git commit -m "feat(eco): admin /credits command"`

---

## Task 7: Plugin wiring

**Files:** Modify `src/plugin.ts`

- [ ] **Step 1: Register balance stats + the admin command.** In `src/plugin.ts`:
  - Add imports: `import { ADMFLAG } from "@s2script/sdk/admin";`, `import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "./eco/balance";`, `import { runCreditsCommand } from "./commands/credits";`.
  - After the existing `api.stats.register(...)` calls, add:
```ts
  api.stats.register(GANG_BALANCE_STAT);
  api.stats.register(PLAYER_BALANCE_STAT);
```
  - After `ctx.commands.register("gang", ...)`, add:
```ts
  ctx.commands.registerAdmin("credits", ADMFLAG.ROOT, (cmd) => runCreditsCommand(api, cmd));
```

- [ ] **Step 2: Full suite + typecheck.** `npm test` (all green) and `npx tsc --noEmit -p tsconfig.json` (clean).
- [ ] **Step 3: Build.** `npm run build` → `dist/gangs.s2sp`.
- [ ] **Step 4: Commit.** `git add src/plugin.ts && git commit -m "feat(eco): register balance stats and /credits admin command"`

- [ ] **Step 5: Manual smoke (needs a server, documented as pending):** `/gang balance` shows 0; admin `/credits <you> 500`; `/gang balance` shows 500; `/gang deposit 200` moves 200 to the bank; `/gang balance` shows personal 300 + bank 200.

---

## Self-Review Notes

- **Spec coverage:** balance stat (Task 1) · EcoManager semantics incl. bank-first + BANK_WITHDRAW gate (Task 2) · events + contract (Task 3) · eco namespace + emits (Task 4) · balance/deposit commands (Task 5) · admin /credits (Task 6) · registration/wiring (Task 7).
- **Faithfulness:** `gang_native_balance` id, gang-bank-first purchase, bank counted only with `BANK_WITHDRAW`, deposit = player→bank via `tryPurchase(excludeGang) + grantGang`.
- **Type consistency:** `EcoManager` method names used by `buildGangsApi` (Task 4) match Task 2; `eco` contract (Task 3) matches the runtime namespace (Task 4).
- **Waves for the workflow:** W1 [1] → W2 [2, 3] → W3 [4] → W4 [5, 6] → W5 [7]. No two tasks in a wave share a file.
