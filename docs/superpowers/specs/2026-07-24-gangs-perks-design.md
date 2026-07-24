# Gangs Perks (Core) — Design

**Date:** 2026-07-24
**Status:** Approved (autonomous run — Tranche A, sub-project 3 of 8)
**Builds on:** the shipped core + Economy + Menus (`@gangs/api`, `eco`, `ranks`, menu model/router).
**Upstream:** `edgegamers/Gangs` — `PerkManager`, `BasePerk`, `CapacityPerk`, `GangChatPerk`,
`MotdPerk`, `PurchaseCommand`, `PerksCommand`/`PerksMenu`.

## Goal

Add the gang perk system: a registry of purchasable perks (each backed by a stat), a `perks`
namespace on `@gangs/api`, purchase/list/MOTD commands, and menu integration. Ships the three
**non-cosmetic** perks that are fully testable off-server: **Capacity**, **Gang Chat**, and **MOTD**.

## Scope

**In scope**
- **Perk framework:** a `Perk` object shape (`id`, `name`, `description`, `descriptor`, `getCost`,
  `onPurchase`) + a `PerkRegistry` (register/list/get). Pure, unit-tested.
- **`perks` API namespace:** `list()`, `getCost(gangId, perkId)`, `getCapacity(gangId)`,
  `purchase(steam, perkId)` (gated `PURCHASE_PERKS`, uses `eco.tryPurchase` then `perk.onPurchase`,
  returns a typed result).
- **Commands:** `sm_gang_perks` (list perks + costs), `sm_gang_purchase <perkId>`, `sm_gang_motd <text>`.
- **Concrete perks:**
  - **Capacity** (`gang_native_capacity`, gang scalar `INT`, default 1, max 15) — cost formula
    `ceil((100·s + 4.9·s⁴)/500)·100` for the next size; **enforced at join** (`sm_gang_join` refuses a
    full gang).
  - **Gang Chat** (`gang_native_chat`, gang scalar `INT` used as bool 0/1) — once purchased, members
    with `SEND_GANG_CHAT` type `.message` to talk to online gang members (runtime `onSay` hook).
  - **MOTD** (`gang_native_motd`, gang scalar `VARCHAR(255)`) — purchased once (cost 7500); set via
    `sm_gang_motd <text>` (gated `MANAGE_PERKS`); shown in the gang menu header.
- **Menu integration:** a "Perks" entry in the main menu → a perks list menu that purchases on select;
  the MOTD shown in the main-menu title when set.

**Out of scope — deferred to a follow-on "Cosmetic Perks" sub-project** (needs on-server entity/schema
work, untestable off-server):
- **SmokeColor** (`gang_native_smoke`) — recolor smoke on `smokegrenade_detonate` via entity fields.
- **Display** (`display_perk`) — gang tag in the scoreboard/chat via player clan-tag entity fields.
These require low-level `EntityRef` offset manipulation against the CS2 schema and must be verified on
a live server; porting them blind (in an untestable fan-out) would risk plausible-but-wrong code. They
get their own sub-project once the offsets are confirmed on a server.

## Faithful semantics

- **Capacity:** stored value defaults to 1 (0 is treated as 1); `getCost` returns null at max (15);
  `onPurchase` increments by 1. Join is refused when `members.length >= capacity`.
- **Purchase flow** (upstream `PurchaseCommand`): resolve perk by id → require `PURCHASE_PERKS` →
  `getCost` (null ⇒ unpurchasable) → `eco.tryPurchase(steam, cost)` (bank-first, may fail) →
  `onPurchase`. Purchases draw from the gang bank first then the player, per Economy.
- **Gang Chat:** prefix `.` (upstream `OnChat` checks `Text.StartsWith('.')`); requires the perk owned
  AND the sender holding `SEND_GANG_CHAT`; broadcasts a formatted line to online members only.
- **MOTD:** purchasable once for 7500; `sm_gang_motd` requires the perk owned and `MANAGE_PERKS`.

## API additions (`@gangs/api`)

```ts
perks: {
  list(): { id: string; name: string; description: string }[];
  getCost(gangId: number, perkId: string): Promise<number | null>;   // null = unpurchasable now
  getCapacity(gangId: number): Promise<number>;                       // >= 1
  purchase(steam: string, perkId: string): Promise<PurchaseResult>;
};

type PurchaseResult = {
  ok: boolean;
  reason: "ok" | "unknown_perk" | "not_in_gang" | "no_permission" | "unpurchasable" | "insufficient_funds";
  cost?: number;      // present when a cost was computed
  balance?: number;   // remaining balance after an ok purchase
};
```

No new events in v0.1 (perk purchases are announced in-gang via the reply/gang chat, not the event
bus). Additive only.

## Architecture / files

- `src/perks/perk.ts` — `interface Perk`, the cost formula `capacityCostFor(size)`, and the three
  concrete perk objects (`CAPACITY_PERK`, `GANGCHAT_PERK`, `MOTD_PERK`) with their descriptors +
  pure `getCost`/`onPurchase` (operate through the `GangsApi.stats` surface). SDK-free.
- `src/perks/perk-registry.ts` — `PerkRegistry` (Map by id; `register`, `list`, `get`, `all`). SDK-free.
- `src/api/impl.ts` + `api.d.ts` — the `perks` namespace + `PurchaseResult`; construct a `PerkRegistry`
  inside `buildGangsApi`, register the three perks, wire `purchase` through `ranks`/`eco`.
- `src/commands/perks.ts` — `cmdPerks`, `cmdPurchase`, `cmdMotd`; added to `COMMANDS`. SDK-free.
- `src/commands/handlers.ts` — add the capacity gate to `cmdJoin` (`api.perks.getCapacity`).
- `src/perks/gang-chat.ts` — runtime `onSay` hook (`registerGangChat(ctx, api, getMsg)`); the pure
  `parseGangChat(text)` (strip `.`) + eligibility check live here but SDK-free helpers are separable.
  This file imports `@s2script/sdk/*` → runtime-only, not unit-tested (smoke-tested).
- `src/menus/menu-model.ts` + `menu-router.ts` — add a `nav:perks` main-menu entry (when
  `PURCHASE_PERKS`) and a `perksMenuModel` listing perks with costs; route `perk:<id>` →
  `sm_gang_purchase <id>`. Also surface the MOTD in the main-menu title.
- `src/plugin.ts` — register the three perk stat descriptors, register the perks on the api, and wire
  the gang-chat `onSay` hook.

**Testability split (enforced):** `perk.ts`, `perk-registry.ts`, `perks.ts`, and the menu changes are
SDK-free and unit-tested. Only `gang-chat.ts` and the plugin wiring touch the SDK.

## Error handling

- `purchase` returns a typed `PurchaseResult` (never throws) — the command maps each reason to a reply.
- `sm_gang_purchase` with an unknown id → "no such perk" + the list. `sm_gang_motd` before the perk is
  owned → "purchase MOTD first". Capacity at max → `getCost` null → "already at max".
- Join gate: a full gang replies "gang is full" and does not add the member (checked before
  `members.add`).
- Gang chat: eligibility (membership, perk-owned, `SEND_GANG_CHAT`) is DB-backed and can only be
  resolved async, while `onSay` must answer synchronously whether to suppress the line. Every
  syntactically-valid `.` message from a real (non-bot) client is therefore suppressed up front and
  eligibility is resolved after; a `.` message from a non-member, a gang without the perk, or a member
  lacking `SEND_GANG_CHAT` is **suppressed but not broadcast** (swallowed), not passed through as normal
  chat. (A synchronous eligibility cache, refreshed on membership/perk/rank changes, would let ineligible
  `.` messages fall through as normal chat instead — deferred as a follow-on, not required for this
  sub-project.)

## Testing

- `perk.test.ts`: `capacityCostFor` matches the formula at sizes 2/5/15; each perk's `getCost`/
  `onPurchase` round-trip through an in-memory api (capacity increments + maxes out; gangchat/motd
  become unpurchasable once owned).
- `perk-registry.test.ts`: register/list/get.
- `api-perks.test.ts`: `purchase` happy path (deducts credits, applies perk), and each failure reason
  (unknown_perk, no_permission via a permissionless rank, unpurchasable when maxed/owned,
  insufficient_funds); `getCapacity` default 1 then post-purchase.
- `perks-commands.test.ts`: `sm_gang_perks` lists; `sm_gang_purchase` buys/【reports failures】;
  `sm_gang_motd` gated on ownership + `MANAGE_PERKS`.
- `join capacity` (extend handlers test): a gang at capacity refuses a new join.
- `menu-model`/`router` (extend): perks entry appears with `PURCHASE_PERKS`; `perk:<id>` routes to
  `sm_gang_purchase`.
- Gang chat: a small pure test of `parseGangChat`. The `onSay` broadcast is smoke-tested on a server.
- No new dev deps.
