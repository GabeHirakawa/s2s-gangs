# Gangs Menus & Rank Administration — Design

**Date:** 2026-07-24
**Status:** Approved (autonomous run — Tranche A, sub-project 2 of 8)
**Builds on:** the shipped gangs core + Economy (`@gangs/api`, `sm_gang_*` commands).
**Upstream:** `edgegamers/Gangs` — `GangMenu`, `MembersMenu`, `MemberMenu`, `RankMenu`/`RankEditMenu`/
`PermissionsEditMenu`, `DoorPolicyMenu`, `RankCommand`.

## Goal

Add the interactive management UI and the rank-administration actions that back it. Faithful to
upstream, but adapted to the s2script command philosophy: **every action is a first-class
`sm_gang_*` command** (testable, usable without menus), and the interactive menu is a thin
convenience front-end that routes selections to those commands/API. Menus render through the
built-in `@s2script/sdk/menu` `Menu` class (chat + center backends, native pagination).

## Scope

**In scope**
- **Rank administration commands** (a genuine gap — the core has no rank CRUD):
  - `sm_gang_ranks` — list the gang's ranks (rank#, name, permission summary).
  - `sm_gang_rank_create <rank#> <name>` — create a rank (gated `CREATE_RANKS`; new rank must be
    strictly lower than the caller's rank; starts with `Perm.NONE`).
  - `sm_gang_rank_rename <rank#> <name>` — rename (gated `MANAGE_RANKS`).
  - `sm_gang_rank_delete <rank#>` — delete via `DeleteStrat.DEMOTE_FAIL` (gated `MANAGE_RANKS`).
  - `sm_gang_rank_perm <rank#> <permName> <on|off>` — toggle one permission flag on a rank
    (gated `MANAGE_RANKS`; the caller may only grant/revoke perms they themselves hold; cannot edit
    their own rank or any rank ≥ their own; cannot touch rank 0/`OWNER`).
- **Pure menu model** (`menu-model.ts`): functions that build item lists (`{ info, label, disabled }[]`
  + title) for the main menu, members list, member-actions, ranks list, and door-policy — from API
  state + the viewer's permissions. Fully unit-testable.
- **Runtime menu layer** (`menus.ts` + `menu-router.ts`): render a model through the SDK `Menu`, wire
  `onSelect` to a router that invokes the matching command/API, and open submenus.
- `sm_gang_menu` opens the main menu; bare `sm_gang` also opens it (falling back to text info for
  console callers).

**Out of scope** (later)
- Perk-related menu entries (the Perks sub-project adds them).
- Center-screen styling polish (default `Chat` backend is fine; center is available via config later).
- Request-to-join approval UI (request flow itself is deferred).

## Faithful semantics

- Rank hierarchy: lower number = higher rank; 0 = owner. All new ranks are non-negative and strictly
  below the caller. Deleting uses `DEMOTE_FAIL` (upstream `RankCommand.handleDelete`).
- `sm_gang_rank_perm` mirrors upstream's permission-edit rules: **may not grant a permission the
  editor lacks**, may not edit their own or a higher/equal rank, and `OWNER`/rank 0 is untouchable.
- Permission names: a stable name↔flag map derived from the existing `Perm` friendly names
  (e.g. `invite_others`, `kick_others`, `bank_deposit`, …). `sm_gang_rank_perm` accepts the snake_case
  name; `sm_gang_ranks` prints the friendly summary via the existing `describe(perms)`.

## API additions (`@gangs/api`)

No new namespace — rank administration is expressed with the existing `ranks` methods
(`create`, `update`, `delete`, `getAll`, `get`). One convenience is added:

```ts
ranks: {
  // ...existing...
  setPermission(gangId: number, rank: number, perm: number, on: boolean): Promise<boolean>;
}
```

`setPermission` reads the rank, flips the bit, and calls `update` (which already refuses `OWNER` on a
non-zero rank). Caller-authorization (editor holds the perm, rank hierarchy) is enforced in the
command layer, not the API, matching how the other commands gate.

No new events (rank edits are low-value to broadcast in v0.1; `member_rank_changed` already covers
membership moves). This keeps the change additive and small.

## Architecture / files

- `src/domain/perm.ts` — add `PERM_NAMES` (name→flag) + `permFromName(name): number | null` +
  `EDITABLE_PERMS` (the flags a `rank_perm` command may toggle — excludes composed `OWNER`/`ADMINISTRATOR`).
- `src/commands/ranks.ts` — pure handlers: `cmdRanks`, `cmdRankCreate`, `cmdRankRename`,
  `cmdRankDelete`, `cmdRankPerm` (each takes `CmdCtx`); added to the `COMMANDS` registry.
- `src/api/impl.ts` + `api.d.ts` — add `ranks.setPermission`.
- `src/menus/menu-model.ts` — pure model builders (`mainMenuModel`, `membersMenuModel`,
  `memberActionsModel`, `ranksMenuModel`, `doorPolicyModel`) returning `{ title, items }`.
- `src/menus/menu-router.ts` — pure `route(info, ctx)`: given an item's `info` key + a `CmdCtx`-like
  context, perform the action (delegates to the rank/member command handlers or opens a submenu
  descriptor). Returns the next menu model to show, or null to close. Unit-testable.
- `src/menus/menus.ts` — runtime: builds an SDK `Menu` from a model, displays it to a slot, routes
  `onSelect` through `menu-router`, re-displays the returned model. Imports `@s2script/sdk/menu`
  (SDK-touching → not imported by tests, mirroring `gang.ts`).
- `src/commands/gang.ts` — add `openGangMenu(api, msg, slot)` runtime entry; register `sm_gang_menu`;
  bare `sm_gang` opens the menu for a player, text info for console.
- `src/plugin.ts` — register the new rank commands + `sm_gang_menu` (via the COMMANDS registry, so
  minimal change).

**Testability split (learned from Economy):** everything pure (perm mapping, rank command handlers,
menu model, router) has NO `@s2script/sdk/*` import and is unit-tested. Only `menus.ts` and the
`sm_gang_menu` registrar touch the SDK `Menu`, and they are smoke-tested on a server.

## Error handling

- Rank commands validate: numeric rank in range, name non-empty, hierarchy/permission rules → usage or
  no-permission replies; no writes on failure.
- `permFromName` returns null for an unknown name → the command replies with the valid names list.
- Menu router: an unknown `info` key closes the menu (no throw). A stale gang/member (disconnected,
  disbanded mid-menu) resolves to a "no longer available" reply and closes.

## Testing

- `perm.test.ts` (extend): `permFromName` round-trips names; `EDITABLE_PERMS` excludes OWNER/ADMIN.
- `ranks-commands.test.ts`: create (hierarchy + CREATE_RANKS gate), rename, delete (DEMOTE_FAIL),
  `rank_perm` on/off with the "can't grant what you lack" and "can't edit own/higher rank" guards,
  and `ranks` listing.
- `api` ranks test (extend): `setPermission` flips a bit and persists; refuses OWNER on non-zero rank.
- `menu-model.test.ts`: main menu hides entries the viewer lacks perms for; members model paginates
  input list; member-actions model shows only promote/demote/kick the viewer may use; door-policy
  model has three options; ranks model lists ranks.
- `menu-router.test.ts`: routing a member-action `info` performs the action via the injected context;
  unknown `info` closes.
- No new dev deps; same vitest + better-sqlite3 harness. `menus.ts` (SDK `Menu`) is smoke-tested only.
