# Gangs Economy — Design

**Date:** 2026-07-23
**Status:** Approved (autonomous run — Tranche A, sub-project 1 of 8)
**Builds on:** the shipped gangs core (`@gangs/api`, stat system, managers).
**Upstream:** `edgegamers/Gangs` — `EcoManager`, `BalanceStat`, gang `DepositCommand`, `BalanceCommand`.

## Goal

Add a self-contained credits economy to the `gangs` plugin, extending `@gangs/api` with an `eco`
namespace and adding the money commands. Credits are stored faithfully as the upstream
`gang_native_balance` scalar-int stat — per player and per gang bank — with no external store
dependency. This unblocks perks, coinflip, ecorewards, raffle, and leaderboard.

## Scope

**In scope**
- `BALANCE_STAT` registration (scalar `INT`, statId `gang_native_balance`) for both `gang` and
  `player` scopes → tables `gang_gang_stats_gang_native_balance(GangId, gang_native_balance INT)` and
  `gang_player_stats_gang_native_balance(Steam, gang_native_balance INT)`.
- `EcoManager` implementing the upstream balance/purchase/grant semantics.
- `eco` namespace on `@gangs/api` + two credit events.
- Commands: `/gang balance`, `/gang deposit <amount|all>`, admin `/credits <player> <amount> [reason]`.

**Out of scope** (later sub-projects)
- Perk purchasing (Perks sub-project consumes `eco.tryPurchase`).
- Coinflip / rewards / raffle (satellite plugins consume `eco`).

## Faithful semantics (from upstream `EcoManager`)

- **`getBalance(steam, excludeGangCredits=false)`** — player balance = `player_stats.gang_native_balance`.
  Total adds the gang bank **only if** the member has `BANK_WITHDRAW` (else player-only). `excludeGangCredits`
  forces player-only.
- **`getGangBalance(gangId)`** — `gang_stats.gang_native_balance`.
- **`canAfford(steam, cost, excludeGangCredits?)`** — `getBalance(...) >= cost`.
- **`tryPurchase(steam, cost, {excludeGangCredits})`** — returns the **remaining balance** (negative and
  no-op if unaffordable). When affordable and gang credits are allowed: pull from the **gang bank first**
  (`grantGang(-min(bank, cost))`), then the remainder from the player (`grantPlayer(-rest)`).
- **`grantPlayer(steam, amount, reason?)`** — set player balance += amount; returns new balance; emits
  `player_credits_changed`.
- **`grantGang(gangId, amount, reason?)`** — set gang balance += amount; returns new balance; emits
  `gang_credits_changed`.

Amounts are integers; a purchase never leaves a negative stored balance (guarded before writes).

## API additions (`@gangs/api`)

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

New events (added to `GangEvents`):

| event | payload |
|---|---|
| `player_credits_changed` | `{ steam, balance, delta, reason }` |
| `gang_credits_changed` | `{ gangId, balance, delta, reason }` |

`reason` is `string \| null`.

## Commands (added to the `/gang` dispatcher, plus one admin command)

| command | behavior | gate |
|---|---|---|
| `/gang balance` | show your personal credits and, if you can access it, your gang bank | in a gang or not (personal shows regardless) |
| `/gang deposit <amount\|all>` | move personal credits into the gang bank (`all` = your personal balance) | in a gang + `BANK_DEPOSIT` |
| `/credits <player> <amount> [reason]` | admin: grant (or, with a negative amount, take) credits from an online player | SM admin flag (`ADMFLAG_ROOT` by default) |

Deposit = `tryPurchase(steam, amount, {excludeGangCredits:true})` to take from the player, then
`grantGang(gangId, amount, "deposit")`. `/credits` resolves an online player and calls `grantPlayer`.

## Architecture / files

- `src/eco/balance.ts` — `BALANCE_STAT_ID`, `GANG_BALANCE_STAT`, `PLAYER_BALANCE_STAT` descriptors.
- `src/eco/eco-manager.ts` — `EcoManager` class (deps: `StatManager`, `PlayerManager`, `RankManager`;
  optional `emit`); the balance/purchase/grant logic.
- `src/api/impl.ts` — add the `eco` namespace delegating to an `EcoManager` built inside `buildGangsApi`.
- `src/api/events.ts` + `api.d.ts` — add the two credit events + the `eco` namespace to the contract.
- `src/commands/handlers.ts` — `cmdBalance`, `cmdDeposit`; register in the dispatcher + help.
- `src/commands/credits.ts` — the admin `/credits` handler (pure, testable via injected ctx).
- `src/plugin.ts` — register both balance stat descriptors; construct nothing extra (EcoManager lives in
  `buildGangsApi`); register the `/credits` admin command.

**Boundary rule unchanged:** `eco` methods traffic in plain numbers/strings; events carry plain data.
Balance is a JS-safe integer (credits are small), unlike SteamID64.

## Error handling

- `tryPurchase` on an unaffordable cost returns the (negative) hypothetical remaining and writes nothing.
- `grantGang` on a nonexistent gang: the stat write still succeeds (upsert); the command layer validates
  gang membership first.
- `/gang deposit` with a non-positive / non-numeric non-`all` argument → usage reply.
- Reads of an unset balance stat return `0` (StatStore returns null → coalesced to 0).

## Testing

- `eco-manager.test.ts` (real in-memory SQLite via the existing `Db` seam): getBalance with/without
  `BANK_WITHDRAW`, gang-bank-first `tryPurchase`, unaffordable no-op, grantPlayer/grantGang round-trips.
- `api` eco tests: `eco.grantPlayer/grantGang` emit the credit events with correct deltas.
- `handlers` tests: `/gang deposit` moves credits player→bank and enforces `BANK_DEPOSIT`; `/gang balance`
  reports; `/credits` grants to a resolved online player.
- No new dev deps; same vitest + better-sqlite3 harness.
