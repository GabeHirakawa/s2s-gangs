# Gangs Perks (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the perk system — a `perks` API namespace, `sm_gang_perks`/`sm_gang_purchase`/`sm_gang_motd` commands, menu integration, and the three non-cosmetic perks (Capacity, Gang Chat, MOTD).

**Architecture:** Extends the shipped core + Economy + Menus. A `PerkRegistry` of `Perk` objects (each backed by a stat) is built inside `buildGangsApi`, which also registers the perk stat descriptors. Purchase flows through `ranks.checkRank(PURCHASE_PERKS)` → `eco.tryPurchase` → `perk.onPurchase`.

**Tech Stack:** TypeScript, `@s2script/sdk`, SQLite. Dev: existing vitest + better-sqlite3.

## Global Constraints

- **Extends an existing codebase.** Read each file before modifying; preserve exports/style/signatures.
- **Testability split (enforced):** pure logic (`perk.ts`, `perk-registry.ts`, `perks.ts`, the menu changes, `parseGangChat`) must NOT import any `@s2script/sdk/*`. Only `src/perks/gang-chat.ts` and `src/plugin.ts` touch the SDK.
- `src` stays within `lib: ES2020` (no `Array.at`/etc.).
- Perk stat ids (faithful to upstream): Capacity `gang_native_capacity` (gang scalar `INT`, default 1, max 15), Gang Chat `gang_native_chat` (gang scalar `INT` as 0/1), MOTD `gang_native_motd` (gang scalar `VARCHAR(255)`).
- Existing signatures to consume: `GangsApi` (`stats.getForGang/setForGang`, `ranks`, `eco`, `players`, `perks`(new)); `StatManager.register`; `EcoManager` (already constructed in `buildGangsApi` as `eco`); `RankManager.checkRank(player, perm)→{ok,required}`; `Perm`/`hasPerm` in `src/domain/perm.ts`; `CmdCtx`, `requireGang`, `gate`, `COMMANDS` in `src/commands/handlers.ts`; `MenuItem`/`MenuModel`/`mainMenuModel`/`ranksMenuModel` in `src/menus/menu-model.ts`; `route`/`RouterCtx` in `src/menus/menu-router.ts`; `HookResult` (`Handled=2`) from `@s2script/sdk/events`; `ctx.clients.onSay` in the plugin factory.
- Run `npm test` (full) green + `npx tsc --noEmit -p tsconfig.json` clean before each commit.

---

## Task 1: Perk framework (pure)

**Files:** Create `src/perks/perk.ts`, `src/perks/perk-registry.ts`; Test `test/perks/perk.test.ts`, `test/perks/perk-registry.test.ts`

**Interfaces — Produces:**
- `interface PerkStats { getForGang<T>(gangId: number, statId: string): Promise<T | null>; setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean> }`
- `interface Perk { id: string; name: string; description: string; descriptor: StatDescriptor; getCost(stats: PerkStats, gangId: number): Promise<number | null>; onPurchase(stats: PerkStats, gangId: number): Promise<void> }`
- `capacityCostFor(size: number): number`
- `CAPACITY_PERK`, `GANGCHAT_PERK`, `MOTD_PERK: Perk`; `ALL_PERKS: Perk[]`
- `class PerkRegistry` — `register(p)`, `get(id): Perk | undefined`, `all(): Perk[]`, `list(): { id; name; description }[]`

- [ ] **Step 1: Failing tests** — `test/perks/perk.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../support/sqlite";
import { StatStore } from "../../src/db/instance.repo";
import { StatManager } from "../../src/managers/stat-manager";
import { capacityCostFor, CAPACITY_PERK, GANGCHAT_PERK, MOTD_PERK, ALL_PERKS } from "../../src/perks/perk";

function stats() {
  const db = makeTestDb();
  const m = new StatManager(
    new StatStore(db, "gang_gang_stats", "GangId", "INTEGER"),
    new StatStore(db, "gang_player_stats", "Steam", "BIGINT"),
  );
  for (const p of ALL_PERKS) m.register(p.descriptor);
  return m;
}

describe("capacityCostFor", () => {
  it("matches the upstream formula", () => {
    expect(capacityCostFor(2)).toBe(Math.ceil((100 * 2 + 4.9 * 2 ** 4) / 500) * 100);
    expect(capacityCostFor(15)).toBe(Math.ceil((100 * 15 + 4.9 * 15 ** 4) / 500) * 100);
  });
});

describe("CAPACITY_PERK", () => {
  it("starts at 1, increments, and maxes out at 15 (getCost null)", async () => {
    const s = stats();
    expect(await CAPACITY_PERK.getCost(s, 1)).toBe(capacityCostFor(2));
    await CAPACITY_PERK.onPurchase(s, 1);
    expect(await s.getForGang<number>(1, "gang_native_capacity")).toBe(2);
    await s.setForGang(1, "gang_native_capacity", 15);
    expect(await CAPACITY_PERK.getCost(s, 1)).toBeNull();
  });
});

describe("GANGCHAT_PERK / MOTD_PERK", () => {
  it("gang chat is a one-time purchase", async () => {
    const s = stats();
    expect(await GANGCHAT_PERK.getCost(s, 1)).toBeGreaterThan(0);
    await GANGCHAT_PERK.onPurchase(s, 1);
    expect(await s.getForGang<number>(1, "gang_native_chat")).toBe(1);
    expect(await GANGCHAT_PERK.getCost(s, 1)).toBeNull();
  });
  it("motd costs 7500 once then becomes unpurchasable", async () => {
    const s = stats();
    expect(await MOTD_PERK.getCost(s, 1)).toBe(7500);
    await MOTD_PERK.onPurchase(s, 1);
    expect(await MOTD_PERK.getCost(s, 1)).toBeNull();
  });
});
```
`test/perks/perk-registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PerkRegistry } from "../../src/perks/perk-registry";
import { CAPACITY_PERK, GANGCHAT_PERK } from "../../src/perks/perk";

describe("PerkRegistry", () => {
  it("registers, gets, and lists perks", () => {
    const r = new PerkRegistry();
    r.register(CAPACITY_PERK); r.register(GANGCHAT_PERK);
    expect(r.get("gang_native_capacity")).toBe(CAPACITY_PERK);
    expect(r.get("nope")).toBeUndefined();
    expect(r.list().map((p) => p.id)).toEqual(["gang_native_capacity", "gang_native_chat"]);
  });
});
```

- [ ] **Step 2: Run — fails.** `npm test test/perks/`

- [ ] **Step 3: Implement** — `src/perks/perk.ts`:
```ts
import type { StatDescriptor } from "../db/instance.repo";

export interface PerkStats {
  getForGang<T>(gangId: number, statId: string): Promise<T | null>;
  setForGang<T>(gangId: number, statId: string, value: T): Promise<boolean>;
}

export interface Perk {
  id: string;
  name: string;
  description: string;
  descriptor: StatDescriptor;
  /** Cost to purchase the next level for this gang, or null if not currently purchasable. */
  getCost(stats: PerkStats, gangId: number): Promise<number | null>;
  /** Apply the purchase (increment level / set flag / seed default). */
  onPurchase(stats: PerkStats, gangId: number): Promise<void>;
}

const CAPACITY_ID = "gang_native_capacity";
const CHAT_ID = "gang_native_chat";
const MOTD_ID = "gang_native_motd";
const MAX_CAPACITY = 15;
const GANGCHAT_COST = 5000; // upstream cost not published in the source we ported from; chosen default
const MOTD_COST = 7500;
const MOTD_DEFAULT = "Use !gang_motd <message> to set the MOTD.";

/** Upstream capacity cost curve: ceil((100·s + 4.9·s⁴)/500)·100. */
export function capacityCostFor(size: number): number {
  return Math.ceil((100 * size + 4.9 * size ** 4) / 500) * 100;
}

async function capacityOf(stats: PerkStats, gangId: number): Promise<number> {
  const c = (await stats.getForGang<number>(gangId, CAPACITY_ID)) ?? 1;
  return c < 1 ? 1 : c;
}

export const CAPACITY_PERK: Perk = {
  id: CAPACITY_ID, name: "Capacity", description: "Increase your gang's member capacity.",
  descriptor: { id: CAPACITY_ID, scope: "gang", kind: "scalar", column: "INT" },
  async getCost(stats, gangId) {
    const c = await capacityOf(stats, gangId);
    return c >= MAX_CAPACITY ? null : capacityCostFor(c + 1);
  },
  async onPurchase(stats, gangId) {
    const c = await capacityOf(stats, gangId);
    if (c < MAX_CAPACITY) await stats.setForGang(gangId, CAPACITY_ID, c + 1);
  },
};

export const GANGCHAT_PERK: Perk = {
  id: CHAT_ID, name: "Gang Chat", description: "Talk to your gang with .message",
  descriptor: { id: CHAT_ID, scope: "gang", kind: "scalar", column: "INT" },
  async getCost(stats, gangId) {
    return (await stats.getForGang<number>(gangId, CHAT_ID)) === 1 ? null : GANGCHAT_COST;
  },
  async onPurchase(stats, gangId) { await stats.setForGang(gangId, CHAT_ID, 1); },
};

export const MOTD_PERK: Perk = {
  id: MOTD_ID, name: "MOTD", description: "A message of the day shown in your gang menu.",
  descriptor: { id: MOTD_ID, scope: "gang", kind: "scalar", column: "VARCHAR(255)" },
  async getCost(stats, gangId) {
    const motd = await stats.getForGang<string>(gangId, MOTD_ID);
    return motd === null || motd === undefined ? MOTD_COST : null;
  },
  async onPurchase(stats, gangId) {
    const motd = await stats.getForGang<string>(gangId, MOTD_ID);
    if (motd === null || motd === undefined) await stats.setForGang(gangId, MOTD_ID, MOTD_DEFAULT);
  },
};

export const ALL_PERKS: Perk[] = [CAPACITY_PERK, GANGCHAT_PERK, MOTD_PERK];
```
`src/perks/perk-registry.ts`:
```ts
import type { Perk } from "./perk";

export class PerkRegistry {
  private perks = new Map<string, Perk>();
  register(p: Perk): void { this.perks.set(p.id, p); }
  get(id: string): Perk | undefined { return this.perks.get(id); }
  all(): Perk[] { return [...this.perks.values()]; }
  list(): { id: string; name: string; description: string }[] {
    return this.all().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  }
}
```

- [ ] **Step 4: Run — passes.** `npm test test/perks/`
- [ ] **Step 5: Commit.** `git add src/perks/perk.ts src/perks/perk-registry.ts test/perks/ && git commit -m "feat(perks): perk framework, registry, and Capacity/GangChat/MOTD perks"`

---

## Task 2: perks namespace in buildGangsApi

**Files:** Modify `src/api/impl.ts`, `api.d.ts`; Test `test/api/perks.test.ts`

**Interfaces — Produces:** `PurchaseResult` + `GangsApi.perks` (`list`, `getCost`, `getCapacity`, `purchase`). `buildGangsApi` constructs a `PerkRegistry`, registers `ALL_PERKS`, registers each perk's stat descriptor via `m.stats.register`, and implements `purchase` (checkRank → getCost → eco.tryPurchase → onPurchase).

- [ ] **Step 1: Failing test** — `test/api/perks.test.ts` (copy the api harness returning `{ a, players }`; note: the harness must NOT manually register perk stats — buildGangsApi does it):
```ts
it("purchase applies the perk and deducts credits (bank-first via eco)", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner"); // owner has PURCHASE_PERKS
  await a.eco.grantPlayer("owner", 100000);
  const before = await a.perks.getCapacity(1);
  const res = await a.perks.purchase("owner", "gang_native_capacity");
  expect(res.ok).toBe(true);
  expect(await a.perks.getCapacity(1)).toBe(before + 1);
});
it("purchase reasons: unknown_perk, not_in_gang, insufficient_funds", async () => {
  const { a, players } = await api();
  await players.createPlayer("solo", "S");
  expect((await a.perks.purchase("solo", "gang_native_capacity")).reason).toBe("not_in_gang");
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  expect((await a.perks.purchase("owner", "nope")).reason).toBe("unknown_perk");
  expect((await a.perks.purchase("owner", "gang_native_capacity")).reason).toBe("insufficient_funds");
});
it("getCapacity defaults to 1", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  expect(await a.perks.getCapacity(1)).toBe(1);
});
```

- [ ] **Step 2: Run — fails.** `npm test test/api/perks.test.ts`

- [ ] **Step 3: Contract** — in `api.d.ts`, add after the `eco` block (inside `GangsApi`):
```ts
  perks: {
    list(): { id: string; name: string; description: string }[];
    getCost(gangId: number, perkId: string): Promise<number | null>;
    getCapacity(gangId: number): Promise<number>;
    purchase(steam: string, perkId: string): Promise<PurchaseResult>;
  };
```
and add a top-level export in `api.d.ts`:
```ts
export type PurchaseResult = {
  ok: boolean;
  reason: "ok" | "unknown_perk" | "not_in_gang" | "no_permission" | "unpurchasable" | "insufficient_funds";
  cost?: number;
  balance?: number;
};
```

- [ ] **Step 4: Implement** — in `src/api/impl.ts`:
  - Add imports at top: `import { Perm } from "../domain/perm";`, `import { PerkRegistry } from "../perks/perk-registry";`, `import { ALL_PERKS } from "../perks/perk";`.
  - Inside `buildGangsApi`, after the `const eco = ...` construction, add:
```ts
  const perks = new PerkRegistry();
  for (const p of ALL_PERKS) { perks.register(p); m.stats.register(p.descriptor); }
```
  - In the returned object, after the `eco: { ... }` block, add:
```ts
    perks: {
      list: () => perks.list(),
      getCost: (gangId, perkId) => {
        const p = perks.get(perkId);
        return p ? p.getCost(m.stats, gangId) : Promise.resolve(null);
      },
      async getCapacity(gangId) {
        const c = (await m.stats.getForGang<number>(gangId, "gang_native_capacity")) ?? 1;
        return c < 1 ? 1 : c;
      },
      async purchase(steam, perkId) {
        const player = await m.players.getPlayer(steam, false);
        if (!player || player.gangId === null) return { ok: false, reason: "not_in_gang" };
        const perk = perks.get(perkId);
        if (!perk) return { ok: false, reason: "unknown_perk" };
        if (!(await m.ranks.checkRank(player, Perm.PURCHASE_PERKS)).ok) return { ok: false, reason: "no_permission" };
        const cost = await perk.getCost(m.stats, player.gangId);
        if (cost === null) return { ok: false, reason: "unpurchasable" };
        const remaining = await eco.tryPurchase(steam, cost); // bank-first
        if (remaining < 0) return { ok: false, reason: "insufficient_funds", cost };
        await perk.onPurchase(m.stats, player.gangId);
        return { ok: true, reason: "ok", cost, balance: remaining };
      },
    },
```

- [ ] **Step 5: Run — passes.** `npm test test/api/perks.test.ts` + `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 6: Commit.** `git add src/api/impl.ts api.d.ts test/api/perks.test.ts && git commit -m "feat(perks): perks API namespace + purchase flow"`

---

## Task 3: perk commands + capacity join-gate

**Files:** Create `src/commands/perks.ts`; Modify `src/commands/handlers.ts` (register in `COMMANDS`; add capacity gate to `cmdJoin`); Test `test/commands/perks-commands.test.ts`, extend `test/commands/handlers.test.ts`

**Interfaces:** Handlers `cmdPerks`, `cmdPurchase`, `cmdMotd`; `COMMANDS` entries `sm_gang_perks`, `sm_gang_purchase`, `sm_gang_motd`. Consumes `api.perks`, `requireGang`/`gate`, `Perm.MANAGE_PERKS`, `MOTD_PERK.id`.

- [ ] **Step 1: Failing test** — `test/commands/perks-commands.test.ts` (copy the handlers `harness()` with `runCommand`):
```ts
it("purchase buys a perk and reports the new balance", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  await h.api.eco.grantPlayer("owner", 100000);
  h.replies.length = 0;
  await runCommand("sm_gang_purchase", h.ctx("owner", ["gang_native_capacity"]));
  const gang = await h.api.gangs.getByMember("owner");
  expect(await h.api.perks.getCapacity(gang!.gangId)).toBe(2);
});
it("purchase reports insufficient funds", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  h.replies.length = 0;
  await runCommand("sm_gang_purchase", h.ctx("owner", ["gang_native_capacity"]));
  expect(h.replies.join("\n").toLowerCase()).toContain("afford");
});
it("motd requires the perk to be purchased first, then sets it", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  const gang = await h.api.gangs.getByMember("owner");
  h.replies.length = 0;
  await runCommand("sm_gang_motd", h.ctx("owner", ["Hello", "world"]));
  expect(h.replies.join("\n").toLowerCase()).toContain("purchase"); // not owned yet
  await h.api.eco.grantPlayer("owner", 100000);
  await runCommand("sm_gang_purchase", h.ctx("owner", ["gang_native_motd"]));
  await runCommand("sm_gang_motd", h.ctx("owner", ["Hello", "world"]));
  expect(await h.api.stats.getForGang<string>(gang!.gangId, "gang_native_motd")).toBe("Hello world");
});
```
Extend `test/commands/handlers.test.ts` with a capacity gate test:
```ts
it("join is refused when the gang is at capacity", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" }, { steam: "bob", name: "Bob" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  const gang = await h.api.gangs.getByMember("owner");
  // default capacity is 1 (owner already fills it)
  await runCommand("sm_gang_invite", h.ctx("owner", ["Bob"]));
  h.replies.length = 0;
  await runCommand("sm_gang_join", h.ctx("bob", ["Wolves"]));
  expect(h.replies.join("\n").toLowerCase()).toContain("full");
  expect((await h.api.players.get("bob"))?.gangId).toBeNull();
});
```

- [ ] **Step 2: Run — fails.** `npm test test/commands/perks-commands.test.ts`

- [ ] **Step 3: Implement** — `src/commands/perks.ts`:
```ts
import type { CmdCtx } from "./ctx";
import { requireGang, gate } from "./handlers";
import { Perm } from "../domain/perm";
import { MOTD_PERK } from "../perks/perk";

export async function cmdPerks(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  ctx.reply("Perks:");
  for (const p of ctx.api.perks.list()) {
    const cost = await ctx.api.perks.getCost(me.gangId, p.id);
    ctx.reply(`  ${p.id} — ${p.name}: ${cost === null ? "maxed/owned" : `${cost} credits`}`);
  }
}

export async function cmdPurchase(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const perkId = (ctx.args[0] ?? "").trim();
  if (!perkId) { ctx.reply(ctx.msg.usage("!gang_purchase <perk>")); return; }
  const res = await ctx.api.perks.purchase(ctx.steam, perkId);
  switch (res.reason) {
    case "ok": ctx.reply(`Purchased ${perkId}. Balance: ${res.balance}.`); break;
    case "unknown_perk": ctx.reply(`No such perk "${perkId}". Try !gang_perks.`); break;
    case "not_in_gang": ctx.reply(ctx.msg.notInGang()); break;
    case "no_permission": ctx.reply(ctx.msg.noPermission("Purchase Perks")); break;
    case "unpurchasable": ctx.reply("That perk cannot be purchased right now."); break;
    case "insufficient_funds": ctx.reply(`You cannot afford that${res.cost ? ` (${res.cost} credits)` : ""}.`); break;
  }
}

export async function cmdMotd(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_PERKS, "Manage Perks"))) return;
  const owned = (await ctx.api.stats.getForGang<string>(me.gangId, MOTD_PERK.id)) !== null;
  if (!owned) { ctx.reply("Your gang must purchase the MOTD perk first (!gang_purchase gang_native_motd)."); return; }
  const text = ctx.args.join(" ").trim();
  if (!text) { ctx.reply(ctx.msg.usage("!gang_motd <message>")); return; }
  await ctx.api.stats.setForGang(me.gangId, MOTD_PERK.id, text);
  ctx.reply("MOTD updated.");
}
```

- [ ] **Step 4: Register + capacity gate** — in `src/commands/handlers.ts`:
  - Import: `import { cmdPerks, cmdPurchase, cmdMotd } from "./perks";`
  - Add to `COMMANDS`: `{ name: "sm_gang_perks", run: cmdPerks }, { name: "sm_gang_purchase", run: cmdPurchase }, { name: "sm_gang_motd", run: cmdMotd },`
  - In `cmdJoin`, after `if (!joinRank) { ctx.reply("Failed to join."); return; }` and BEFORE `await ctx.api.members.add(...)`, insert:
```ts
  const capacity = await ctx.api.perks.getCapacity(gangId);
  const count = (await ctx.api.players.getMembers(gangId)).length;
  if (count >= capacity) { ctx.reply("That gang is full."); return; }
```

- [ ] **Step 5: Run — passes.** `npm test test/commands/perks-commands.test.ts test/commands/handlers.test.ts`
- [ ] **Step 6: Commit.** `git add src/commands/perks.ts src/commands/handlers.ts test/commands/perks-commands.test.ts test/commands/handlers.test.ts && git commit -m "feat(perks): sm_gang_perks/purchase/motd + capacity join-gate"`

---

## Task 4: Menu integration

**Files:** Modify `src/menus/menu-model.ts`, `src/menus/menu-router.ts`; Test extend `test/menus/menu-model.test.ts`, `test/menus/menu-router.test.ts`

**Interfaces:** Add `perksMenuModel(api: GangsApi, gangId: number): Promise<MenuModel>` to menu-model; a `nav:perks` entry in `mainMenuModel` (when `PURCHASE_PERKS`); surface MOTD in the main title. In menu-router add `nav:perks` → perks model and `perk:<id>` → run `sm_gang_purchase` then re-show perks.

- [ ] **Step 1: Failing test** — extend `test/menus/menu-model.test.ts`:
```ts
import { perksMenuModel, mainMenuModel } from "../../src/menus/menu-model";
it("main menu shows Perks for a viewer with PURCHASE_PERKS", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  const model = await mainMenuModel(a, "owner");
  expect(model.items.some((i) => i.info === "nav:perks")).toBe(true);
});
it("perks menu lists perks with perk:<id> info keys", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  const model = await perksMenuModel(a, 1);
  expect(model.items.some((i) => i.info === "perk:gang_native_capacity")).toBe(true);
});
```
extend `test/menus/menu-router.test.ts`:
```ts
it("routes perk:<id> through sm_gang_purchase and returns to the perks menu", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  const calls: Array<[string, string[]]> = [];
  const rctx = { api: a, viewerSteam: "owner", run: async (c: string, args: string[]) => { calls.push([c, args]); } };
  const next = await route("perk:gang_native_capacity", rctx);
  expect(calls).toContainEqual(["sm_gang_purchase", ["gang_native_capacity"]]);
  expect(next?.title.toLowerCase()).toContain("perk");
});
```

- [ ] **Step 2: Run — fails.** `npm test test/menus/`

- [ ] **Step 3: Implement menu-model** — in `src/menus/menu-model.ts`:
  - In `mainMenuModel`, where other perm-gated entries are pushed, add (using the existing `v`/`hasPerm`/`Perm` in scope):
```ts
  if (v && hasPerm(v.perms, Perm.PURCHASE_PERKS)) items.push({ info: "nav:perks", label: "Perks" });
```
  - Surface MOTD in the title: after computing `gang`, read the MOTD and append when set. Replace the title line so it becomes:
```ts
  const motd = v ? await api.stats.getForGang<string>(v.gangId, "gang_native_motd") : null;
  const title = gang ? `Gang: ${gang.name}${motd ? ` — ${motd}` : ""}` : "Gang";
  return { title, items };
```
  - Add a new exported builder:
```ts
export async function perksMenuModel(api: GangsApi, gangId: number): Promise<MenuModel> {
  const items: MenuItem[] = [];
  for (const p of api.perks.list()) {
    const cost = await api.perks.getCost(gangId, p.id);
    items.push({ info: `perk:${p.id}`, label: `${p.name}: ${cost === null ? "owned/max" : `${cost}cr`}`, disabled: cost === null });
  }
  return { title: "Perks", items };
}
```

- [ ] **Step 4: Implement menu-router** — in `src/menus/menu-router.ts`, add before the final `return null;`:
```ts
  if (info === "nav:perks") {
    const g = await gangIdOf(rctx); return g === null ? null : perksMenuModel(rctx.api, g);
  }
  if (info.startsWith("perk:")) {
    await rctx.run("sm_gang_purchase", [info.slice("perk:".length)]);
    const g = await gangIdOf(rctx); return g === null ? null : perksMenuModel(rctx.api, g);
  }
```
and add `perksMenuModel` to the import from `./menu-model`.

- [ ] **Step 5: Run — passes.** `npm test test/menus/`
- [ ] **Step 6: Commit.** `git add src/menus/menu-model.ts src/menus/menu-router.ts test/menus/ && git commit -m "feat(perks): perks menu entry + purchase routing + MOTD in title"`

---

## Task 5: Gang chat runtime + plugin wiring

**Files:** Create `src/perks/gang-chat.ts`; Modify `src/messages.ts`, `src/plugin.ts`; Test `test/perks/gang-chat.test.ts`

**Interfaces:** Pure `parseGangChat(text: string): string | null` (strips the leading `.`; null if not a gang-chat message or empty). Runtime `registerGangChat(ctx, api, getMsg)` hooks `ctx.clients.onSay`. `Messages.gangChat(gangName, playerName, message): string`.

- [ ] **Step 1: Failing test** — `test/perks/gang-chat.test.ts` (pure part only):
```ts
import { describe, it, expect } from "vitest";
import { parseGangChat } from "../../src/perks/gang-chat";

describe("parseGangChat", () => {
  it("strips a leading dot and trims", () => {
    expect(parseGangChat(".hello team")).toBe("hello team");
    expect(parseGangChat(".  spaced ")).toBe("spaced");
  });
  it("returns null for non-gang-chat or empty", () => {
    expect(parseGangChat("hello")).toBeNull();
    expect(parseGangChat(".")).toBeNull();
    expect(parseGangChat("")).toBeNull();
  });
});
```
> Only `parseGangChat` is tested; the `onSay` broadcast is smoke-tested on a server (the test file must import ONLY `parseGangChat`, which lives in gang-chat.ts alongside SDK imports — see the note below).

- [ ] **Step 2: Run — fails.** `npm test test/perks/gang-chat.test.ts`
> If vitest errors with "No known conditions for ./clients" (because gang-chat.ts imports the SDK), MOVE `parseGangChat` into its own SDK-free file `src/perks/gang-chat-parse.ts` and import it there from both gang-chat.ts and the test. Prefer this split up front to avoid the failure: put `parseGangChat` in `src/perks/gang-chat-parse.ts`, and have the test import from there.

- [ ] **Step 3: Implement the pure parser** — `src/perks/gang-chat-parse.ts`:
```ts
/** A gang-chat message is any say-text beginning with '.'; returns the trimmed remainder, or null. */
export function parseGangChat(text: string): string | null {
  if (!text.startsWith(".")) return null;
  const msg = text.slice(1).trim();
  return msg.length > 0 ? msg : null;
}
```
> Update the test import to `from "../../src/perks/gang-chat-parse"`.

- [ ] **Step 4: Message string** — in `src/messages.ts`, add to the `Messages` interface and `makeMessages` return:
```ts
  gangChat(gang: string, name: string, message: string): string;
```
```ts
    gangChat: (gang, name, message) => `[${gang}] ${name}: ${message}`,
```
> Note: gang chat lines are their own format (no `p(tag)` prefix) — they are gang-scoped chat, not plugin notices.

- [ ] **Step 5: Runtime hook** — `src/perks/gang-chat.ts`:
```ts
import { Clients } from "@s2script/sdk/clients";
import { HookResult } from "@s2script/sdk/events";
import type { PluginContext } from "@s2script/sdk/plugin";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import { Perm, hasPerm } from "../domain/perm";
import { parseGangChat } from "./gang-chat-parse";

export { parseGangChat };

/** Hook say-text: a member with the Gang Chat perk + SEND_GANG_CHAT typing ".msg" messages online gang members. */
export function registerGangChat(ctx: PluginContext, api: GangsApi, getMsg: () => Messages): void {
  ctx.clients.onSay((slot, text) => {
    const message = parseGangChat(text);
    if (message === null) return HookResult.Continue;
    const caller = Clients.fromSlot(slot);
    if (!caller || caller.steamId === "0") return HookResult.Continue;
    const steam = caller.steamId;
    // fire-and-forget; suppress the public broadcast immediately since it starts with '.'
    void (async () => {
      const membership = await api.players.getMembership(steam);
      if (!membership) return;
      const enabled = (await api.stats.getForGang<number>(membership.gang.gangId, "gang_native_chat")) === 1;
      if (!enabled || !hasPerm(membership.rank.permissions, Perm.SEND_GANG_CHAT)) return;
      const line = getMsg().gangChat(membership.gang.name, membership.player.name ?? steam, message);
      const members = await api.players.getMembers(membership.gang.gangId);
      const onlineSteams = new Set(members.map((m) => m.steam));
      for (const c of Clients.all()) if (c.isValid() && onlineSteams.has(c.steamId)) c.chat(line);
    })();
    return HookResult.Handled; // don't echo ".msg" to public chat
  });
}
```

- [ ] **Step 6: Plugin wiring** — in `src/plugin.ts`:
  - Import: `import { registerGangChat } from "./perks/gang-chat";`
  - After the command registrations, add: `registerGangChat(ctx, api, () => msg);`
  - (No perk stat registration needed — `buildGangsApi` registers the perk stat descriptors.)

- [ ] **Step 7: Full suite + typecheck + build.** `npm test` (all green), `npx tsc --noEmit -p tsconfig.json` (clean), `npm run build` (→ dist/gangs.s2sp).

- [ ] **Step 8: Commit.** `git add src/perks/gang-chat.ts src/perks/gang-chat-parse.ts src/messages.ts src/plugin.ts test/perks/gang-chat.test.ts && git commit -m "feat(perks): gang chat (.message) runtime hook + wiring"`

- [ ] **Step 9: Manual smoke (server, pending):** buy Capacity via `!gang_purchase gang_native_capacity`; a 2nd player joins (capacity now 2); buy Gang Chat, then `.hello` broadcasts to gang; buy MOTD, `!gang_motd Welcome`, open `!gang` menu and see it in the title.

---

## Self-Review Notes

- **Spec coverage:** framework/registry/perks (T1) · perks API + purchase (T2) · commands + capacity gate (T3) · menu integration (T4) · gang chat + wiring (T5). Deferred: SmokeColor/Display (entity perks) — not in this plan by design.
- **Testability split:** T1–T4 + `parseGangChat` are SDK-free/tested; only `gang-chat.ts` + plugin wiring touch the SDK. The `gang-chat-parse.ts` split (T5 step 2/3) keeps the tested parser SDK-free.
- **Type consistency:** `Perk`/`PerkStats` (T1) consumed by T2; `PurchaseResult` (T2 contract) matches the impl; `perksMenuModel` (T4) matches the router import; `perks.getCapacity` used by both T3 (join gate) and T4.
- **Waves for the workflow:** W1 [1] → W2 [2] → W3 [3, 4] → W4 [5]. (T2 needs T1; T3+T4 need T2 and touch disjoint files — perks.ts+handlers.ts vs menu-*.ts; T5 needs T1+T3.)
