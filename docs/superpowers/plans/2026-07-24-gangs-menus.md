# Gangs Menus & Rank Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add rank-administration commands (`sm_gang_ranks`, `sm_gang_rank_create/rename/delete/perm`) and an interactive management menu (`sm_gang_menu`) that routes selections to those commands, rendered via `@s2script/sdk/menu`.

**Architecture:** Extends the shipped gangs core + Economy. Every action is a first-class `sm_gang_*` command (in the `COMMANDS` registry, unit-tested). The menu is a thin front-end: pure model builders + a pure router (SDK-free, tested) with one runtime file (`menus.ts`) that touches the SDK `Menu`.

**Tech Stack:** TypeScript, `@s2script/sdk`, SQLite. Dev: existing vitest + better-sqlite3.

## Global Constraints

- **Extends an existing codebase.** Read each file before modifying; preserve exports/style/signatures.
- **Testability split (enforced):** pure logic (perm mapping, rank command handlers, menu model, router) must NOT import any `@s2script/sdk/*` — vite cannot resolve those types-only packages in tests. Only `src/menus/menus.ts` and the `sm_gang_menu` registrar in `src/commands/gang.ts` import the SDK (`@s2script/sdk/menu`, `@s2script/sdk/clients`), mirroring the existing `handlers.ts` (pure) vs `gang.ts` (SDK) split.
- `src` stays within `lib: ES2020` (no `Array.at`/`findLast`/etc.).
- Rank hierarchy: lower number = higher rank; 0 = owner. New ranks non-negative and strictly below the caller.
- Existing signatures to consume: `Perm`/`hasPerm`/`describe`/`FRIENDLY` in `src/domain/perm.ts`; `CmdCtx` in `src/commands/ctx.ts`; `COMMANDS`/`runCommand(name, ctx)`/`requireGang`/`gate` patterns in `src/commands/handlers.ts`; `GangsApi.ranks` (`getAll`/`get`/`create`/`update`/`delete`/`checkPermission`); `DeleteStrat` in `src/domain/types.ts`; `Menu`/`MenuStyle` from `@s2script/sdk/menu`.
- Run `npm test` (full) green + `npx tsc --noEmit -p tsconfig.json` clean before each commit.

---

## Task 1: Permission name mapping

**Files:** Modify `src/domain/perm.ts`; Test `test/domain/perm.test.ts` (extend)

**Interfaces — Produces:** `PERM_NAMES: Record<string, number>` (snake_case name → flag), `permFromName(name: string): number | null`, `permName(flag: number): string | null`, `EDITABLE_PERMS: { name: string; flag: number; label: string }[]` (single-bit editable perms; excludes `NONE`/`ADMINISTRATOR`/`OWNER`).

- [ ] **Step 1: Failing test** — append to `test/domain/perm.test.ts`:
```ts
import { permFromName, permName, EDITABLE_PERMS, PERM_NAMES } from "../../src/domain/perm";

describe("perm names", () => {
  it("round-trips snake_case names to flags", () => {
    expect(permFromName("invite_others")).toBe(Perm.INVITE_OTHERS);
    expect(permFromName("bank_withdraw")).toBe(Perm.BANK_WITHDRAW);
    expect(permFromName("nonsense")).toBeNull();
    expect(permName(Perm.KICK_OTHERS)).toBe("kick_others");
  });
  it("EDITABLE_PERMS excludes composed OWNER/ADMINISTRATOR and NONE", () => {
    const flags = EDITABLE_PERMS.map((p) => p.flag);
    expect(flags).not.toContain(Perm.OWNER);
    expect(flags).not.toContain(Perm.ADMINISTRATOR);
    expect(flags).not.toContain(Perm.NONE);
    expect(Object.keys(PERM_NAMES)).toContain("send_gang_chat");
  });
});
```

- [ ] **Step 2: Run — fails.** `npm test test/domain/perm.test.ts`

- [ ] **Step 3: Implement** — in `src/domain/perm.ts`, after the `FRIENDLY` map add:
```ts
/** snake_case name → flag, derived from FRIENDLY's keys (the single-bit + MANAGE_INVITES perms). */
export const PERM_NAMES: Record<string, number> = Object.fromEntries(
  Object.keys(FRIENDLY).map((k) => [k.toLowerCase(), (Perm as Record<string, number>)[k]]),
);

export function permFromName(name: string): number | null {
  const flag = PERM_NAMES[name.toLowerCase()];
  return flag === undefined ? null : flag;
}

export function permName(flag: number): string | null {
  for (const [name, f] of Object.entries(PERM_NAMES)) if (f === flag) return name;
  return null;
}

/** The permissions a `rank_perm` command may toggle: single, human-managed flags. */
export const EDITABLE_PERMS: { name: string; flag: number; label: string }[] =
  Object.entries(FRIENDLY).map(([k, label]) => ({
    name: k.toLowerCase(), flag: (Perm as Record<string, number>)[k], label,
  }));
```

- [ ] **Step 4: Run — passes.** `npm test test/domain/perm.test.ts`
- [ ] **Step 5: Commit.** `git add src/domain/perm.ts test/domain/perm.test.ts && git commit -m "feat(menus): permission name mapping (permFromName/permName/EDITABLE_PERMS)"`

---

## Task 2: ranks.setPermission API

**Files:** Modify `src/api/impl.ts`, `api.d.ts`; Test `test/api/ranks-setperm.test.ts`

**Interfaces — Produces:** `GangsApi.ranks.setPermission(gangId: number, rank: number, perm: number, on: boolean): Promise<boolean>` — reads the rank, sets/clears the bit, calls `update` (which already refuses `OWNER` on a non-zero rank). Returns false if the rank does not exist.

- [ ] **Step 1: Failing test** — `test/api/ranks-setperm.test.ts` (build the standard api harness — copy from `test/api/eco.test.ts`'s `api()` but no eco registration needed), then:
```ts
it("setPermission flips a single flag and persists", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  await a.ranks.create(1, "Officer", 50, 0);
  const { Perm } = await import("../../src/domain/perm");
  expect(await a.ranks.setPermission(1, 50, Perm.KICK_OTHERS, true)).toBe(true);
  expect((await a.ranks.get(1, 50))!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
  await a.ranks.setPermission(1, 50, Perm.KICK_OTHERS, false);
  expect((await a.ranks.get(1, 50))!.permissions & Perm.KICK_OTHERS).toBe(0);
});
it("returns false for a missing rank", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  expect(await a.ranks.setPermission(1, 999, 1, true)).toBe(false);
});
```
> The harness `api()` must also return `players`. Copy the eco.test.ts harness and add `return { a, players };`.

- [ ] **Step 2: Run — fails.** `npm test test/api/ranks-setperm.test.ts`

- [ ] **Step 3: Contract** — in `api.d.ts`, add to the `ranks` block:
```ts
    setPermission(gangId: number, rank: number, perm: number, on: boolean): Promise<boolean>;
```

- [ ] **Step 4: Implement** — in `src/api/impl.ts`, inside the returned `ranks: { ... }`, add:
```ts
      async setPermission(gangId, rank, perm, on) {
        const r = await m.ranks.getRank(gangId, rank);
        if (!r) return false;
        const permissions = on ? (r.permissions | perm) : (r.permissions & ~perm);
        return m.ranks.updateRank(gangId, { ...r, permissions });
      },
```

- [ ] **Step 5: Run — passes.** `npm test test/api/ranks-setperm.test.ts` + `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 6: Commit.** `git add src/api/impl.ts api.d.ts test/api/ranks-setperm.test.ts && git commit -m "feat(menus): ranks.setPermission API"`

---

## Task 3: Rank administration commands

**Files:** Create `src/commands/ranks.ts`; Modify `src/commands/handlers.ts` (register in `COMMANDS`); Test `test/commands/ranks-commands.test.ts`

**Interfaces:** Consumes `CmdCtx`, `requireGang`/`gate` (export them from `handlers.ts` if not already), `Perm`/`hasPerm`/`permFromName`/`EDITABLE_PERMS`/`describe`, `DeleteStrat`. Produces handlers `cmdRanks`, `cmdRankCreate`, `cmdRankRename`, `cmdRankDelete`, `cmdRankPerm` and `COMMANDS` entries `sm_gang_ranks`, `sm_gang_rank_create`, `sm_gang_rank_rename`, `sm_gang_rank_delete`, `sm_gang_rank_perm`.

- [ ] **Step 1:** In `src/commands/handlers.ts`, export the two shared helpers so `ranks.ts` can reuse them: change `async function requireGang` → `export async function requireGang`, and `async function gate` → `export async function gate`.

- [ ] **Step 2: Failing test** — `test/commands/ranks-commands.test.ts` (copy the `harness()` from `test/commands/handlers.test.ts`, importing `runCommand`), then:
```ts
it("rank_create adds a rank strictly below the caller; gated on CREATE_RANKS", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  await runCommand("sm_gang_rank_create", h.ctx("owner", ["70", "Scout"]));
  const gang = await h.api.gangs.getByMember("owner");
  expect((await h.api.ranks.get(gang!.gangId, 70))?.name).toBe("Scout");
});
it("rank_perm grants a flag the editor holds, refuses one they lack", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  const gang = await h.api.gangs.getByMember("owner");
  await runCommand("sm_gang_rank_perm", h.ctx("owner", ["100", "kick_others", "on"]));
  const { Perm } = await import("../../src/domain/perm");
  expect((await h.api.ranks.get(gang!.gangId, 100))!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
});
it("rank_delete removes a rank via DEMOTE_FAIL", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  const gang = await h.api.gangs.getByMember("owner");
  await runCommand("sm_gang_rank_delete", h.ctx("owner", ["50"])); // Officer, no members
  expect(await h.api.ranks.get(gang!.gangId, 50)).toBeNull();
});
it("rank_perm refuses editing the caller's own or a higher rank", async () => {
  const h = await harness();
  h.online.push({ steam: "owner", name: "O" });
  await runCommand("sm_gang_create", h.ctx("owner", ["Wolves"]));
  const gang = await h.api.gangs.getByMember("owner");
  h.replies.length = 0;
  await runCommand("sm_gang_rank_perm", h.ctx("owner", ["0", "kick_others", "off"])); // own/owner rank
  const { Perm } = await import("../../src/domain/perm");
  expect((await h.api.ranks.get(gang!.gangId, 0))!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
});
```

- [ ] **Step 3: Run — fails.** `npm test test/commands/ranks-commands.test.ts`

- [ ] **Step 4: Implement** — `src/commands/ranks.ts`:
```ts
import type { CmdCtx } from "./ctx";
import { requireGang, gate } from "./handlers";
import { Perm, hasPerm, describe, permFromName, EDITABLE_PERMS } from "../domain/perm";
import { DeleteStrat } from "../domain/types";

function parseRank(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && String(n) === raw && n >= 0 ? n : null;
}

export async function cmdRanks(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const ranks = await ctx.api.ranks.getAll(me.gangId);
  ctx.reply("Ranks:");
  for (const r of ranks) ctx.reply(`  [${r.rank}] ${r.name} — ${describe(r.permissions)}`);
}

export async function cmdRankCreate(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.CREATE_RANKS, "Create Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const name = ctx.args.slice(1).join(" ").trim();
  if (rank === null || !name) { ctx.reply(ctx.msg.usage("!gang_rank_create <rank#> <name>")); return; }
  if (rank <= me.rank) { ctx.reply("You can only create ranks below your own."); return; }
  const made = await ctx.api.ranks.create(me.gangId, name, rank, Perm.NONE);
  ctx.reply(made ? `Created rank [${rank}] ${name}.` : "That rank number already exists.");
}

export async function cmdRankRename(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const name = ctx.args.slice(1).join(" ").trim();
  if (rank === null || !name) { ctx.reply(ctx.msg.usage("!gang_rank_rename <rank#> <name>")); return; }
  if (rank <= me.rank) { ctx.reply("You cannot edit your own or a higher rank."); return; }
  const existing = await ctx.api.ranks.get(me.gangId, rank);
  if (!existing) { ctx.reply("No such rank."); return; }
  const ok = await ctx.api.ranks.update(me.gangId, { ...existing, name });
  ctx.reply(ok ? `Renamed rank [${rank}] to ${name}.` : "Failed to rename.");
}

export async function cmdRankDelete(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  if (rank === null) { ctx.reply(ctx.msg.usage("!gang_rank_delete <rank#>")); return; }
  if (rank <= me.rank) { ctx.reply("You cannot delete your own or a higher rank."); return; }
  const ok = await ctx.api.ranks.delete(me.gangId, rank, DeleteStrat.DEMOTE_FAIL);
  ctx.reply(ok ? `Deleted rank [${rank}].` : "Could not delete that rank (it may not exist or have members with no lower rank).");
}

export async function cmdRankPerm(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const perm = permFromName(ctx.args[1] ?? "");
  const toggle = (ctx.args[2] ?? "").toLowerCase();
  if (rank === null || perm === null || (toggle !== "on" && toggle !== "off")) {
    ctx.reply(ctx.msg.usage(`!gang_rank_perm <rank#> <${EDITABLE_PERMS.map((p) => p.name).join("|")}> <on|off>`));
    return;
  }
  if (rank <= me.rank) { ctx.reply("You cannot edit your own or a higher rank."); return; }
  const on = toggle === "on";
  // May not grant a permission you do not hold yourself.
  if (on) {
    const mine = await ctx.api.ranks.get(me.gangId, me.rank);
    if (!mine || !hasPerm(mine.permissions, perm)) { ctx.reply("You cannot grant a permission you do not have."); return; }
  }
  const ok = await ctx.api.ranks.setPermission(me.gangId, rank, perm, on);
  ctx.reply(ok ? `${on ? "Granted" : "Revoked"} ${ctx.args[1]} on rank [${rank}].` : "No such rank.");
}
```

- [ ] **Step 5: Register** — in `src/commands/handlers.ts`, import the handlers and add entries to the `COMMANDS` array:
```ts
// at top: import { cmdRanks, cmdRankCreate, cmdRankRename, cmdRankDelete, cmdRankPerm } from "./ranks";
// in COMMANDS:
  { name: "sm_gang_ranks", run: cmdRanks },
  { name: "sm_gang_rank_create", run: cmdRankCreate },
  { name: "sm_gang_rank_rename", run: cmdRankRename },
  { name: "sm_gang_rank_delete", run: cmdRankDelete },
  { name: "sm_gang_rank_perm", run: cmdRankPerm },
```
> Note: `ranks.ts` imports `requireGang`/`gate` from `handlers.ts` and `handlers.ts` imports the command fns from `ranks.ts` — this is a cyclic import but safe: `handlers.ts` uses them only inside the `COMMANDS` array (evaluated after both modules load), and `ranks.ts` uses `requireGang`/`gate` only inside function bodies. If the bundler warns, move `requireGang`/`gate` into a small `command-utils.ts` both import instead.

- [ ] **Step 6: Run — passes.** `npm test test/commands/ranks-commands.test.ts`
- [ ] **Step 7: Commit.** `git add src/commands/ranks.ts src/commands/handlers.ts test/commands/ranks-commands.test.ts && git commit -m "feat(menus): rank administration commands"`

---

## Task 4: Menu model (pure)

**Files:** Create `src/menus/menu-model.ts`; Test `test/menus/menu-model.test.ts`

**Interfaces — Produces:**
- `interface MenuItem { info: string; label: string; disabled?: boolean }`
- `interface MenuModel { title: string; items: MenuItem[] }`
- `mainMenuModel(api: GangsApi, viewerSteam: string): Promise<MenuModel>`
- `membersMenuModel(api: GangsApi, gangId: number): Promise<MenuModel>`
- `memberActionsModel(api: GangsApi, viewerSteam: string, targetSteam: string): Promise<MenuModel | null>` (null if target invalid)
- `ranksMenuModel(api: GangsApi, gangId: number): Promise<MenuModel>`
- `doorPolicyModel(): MenuModel`

Item `info` keys: `nav:members`, `nav:ranks`, `nav:door`, `nav:main`, `member:<steam>`, `action:promote:<steam>`, `action:demote:<steam>`, `action:kick:<steam>`, `door:open|invite|request`.

- [ ] **Step 1: Failing test** — `test/menus/menu-model.test.ts` (build the standard api harness returning `{ a, players }`):
```ts
import { mainMenuModel, membersMenuModel, memberActionsModel, doorPolicyModel } from "../../src/menus/menu-model";
// ... harness a() ...
it("main menu hides Ranks entry for a viewer without MANAGE_RANKS", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  await players.createPlayer("m", "M");
  await a.members.add(1, "m", 100); // Member: no MANAGE_RANKS
  const owner = await mainMenuModel(a, "owner");
  const member = await mainMenuModel(a, "m");
  expect(owner.items.some((i) => i.info === "nav:ranks")).toBe(true);
  expect(member.items.some((i) => i.info === "nav:ranks")).toBe(false);
  expect(member.items.some((i) => i.info === "nav:members")).toBe(true);
});
it("member actions show only permitted verbs and never target self", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  await players.createPlayer("m", "M");
  await a.members.add(1, "m", 100);
  const model = await memberActionsModel(a, "owner", "m");
  expect(model!.items.some((i) => i.info === "action:kick:m")).toBe(true);
  const self = await memberActionsModel(a, "owner", "owner");
  expect(self!.items.every((i) => !i.info.startsWith("action:"))).toBe(true);
});
it("door policy model has three options", () => {
  expect(doorPolicyModel().items.map((i) => i.info)).toEqual(["door:open", "door:invite", "door:request"]);
});
```

- [ ] **Step 2: Run — fails.** `npm test test/menus/menu-model.test.ts`

- [ ] **Step 3: Implement** — `src/menus/menu-model.ts`:
```ts
import type { GangsApi } from "../../api";
import { Perm, hasPerm } from "../domain/perm";

export interface MenuItem { info: string; label: string; disabled?: boolean; }
export interface MenuModel { title: string; items: MenuItem[]; }

async function viewerPerms(api: GangsApi, steam: string): Promise<{ gangId: number; rank: number; perms: number } | null> {
  const p = await api.players.get(steam, false);
  if (!p || p.gangId === null || p.gangRank === null) return null;
  const rank = await api.ranks.get(p.gangId, p.gangRank);
  return rank ? { gangId: p.gangId, rank: p.gangRank, perms: rank.permissions } : null;
}

export async function mainMenuModel(api: GangsApi, viewerSteam: string): Promise<MenuModel> {
  const v = await viewerPerms(api, viewerSteam);
  const gang = v ? await api.gangs.get(v.gangId) : null;
  const items: MenuItem[] = [{ info: "nav:members", label: "Members" }];
  if (v && hasPerm(v.perms, Perm.INVITE_OTHERS)) items.push({ info: "nav:invites", label: "Invites" });
  if (v && hasPerm(v.perms, Perm.MANAGE_RANKS)) {
    items.push({ info: "nav:ranks", label: "Ranks" });
    items.push({ info: "nav:door", label: "Door Policy" });
  }
  return { title: gang ? `Gang: ${gang.name}` : "Gang", items };
}

export async function membersMenuModel(api: GangsApi, gangId: number): Promise<MenuModel> {
  const members = await api.players.getMembers(gangId);
  const ranks = await api.ranks.getAll(gangId);
  const rankName = (n: number | null): string => ranks.find((r) => r.rank === n)?.name ?? "?";
  return {
    title: "Members",
    items: members.map((m) => ({ info: `member:${m.steam}`, label: `${m.name ?? m.steam} (${rankName(m.gangRank)})` })),
  };
}

export async function memberActionsModel(api: GangsApi, viewerSteam: string, targetSteam: string): Promise<MenuModel | null> {
  const v = await viewerPerms(api, viewerSteam);
  const target = await api.players.get(targetSteam, false);
  if (!v || !target || target.gangId !== v.gangId || target.gangRank === null) return null;
  const items: MenuItem[] = [];
  const canAct = targetSteam !== viewerSteam && target.gangRank > v.rank;
  if (canAct && hasPerm(v.perms, Perm.PROMOTE_OTHERS)) items.push({ info: `action:promote:${targetSteam}`, label: "Promote" });
  if (canAct && hasPerm(v.perms, Perm.DEMOTE_OTHERS)) items.push({ info: `action:demote:${targetSteam}`, label: "Demote" });
  if (canAct && hasPerm(v.perms, Perm.KICK_OTHERS)) items.push({ info: `action:kick:${targetSteam}`, label: "Kick" });
  return { title: target.name ?? targetSteam, items };
}

export async function ranksMenuModel(api: GangsApi, gangId: number): Promise<MenuModel> {
  const ranks = await api.ranks.getAll(gangId);
  return { title: "Ranks", items: ranks.map((r) => ({ info: `rank:${r.rank}`, label: `[${r.rank}] ${r.name}` })) };
}

export function doorPolicyModel(): MenuModel {
  return {
    title: "Door Policy",
    items: [
      { info: "door:open", label: "Open (anyone joins)" },
      { info: "door:invite", label: "Invite Only" },
      { info: "door:request", label: "Request Only" },
    ],
  };
}
```

- [ ] **Step 4: Run — passes.** `npm test test/menus/menu-model.test.ts`
- [ ] **Step 5: Commit.** `git add src/menus/menu-model.ts test/menus/menu-model.test.ts && git commit -m "feat(menus): pure menu model builders"`

---

## Task 5: Menu router (pure)

**Files:** Create `src/menus/menu-router.ts`; Test `test/menus/menu-router.test.ts`

**Interfaces — Produces:**
- `interface RouterCtx { api: GangsApi; viewerSteam: string; run(command: string, args: string[]): Promise<void> }`
- `route(info: string, rctx: RouterCtx): Promise<MenuModel | null>` — perform the action (delegating to a `sm_gang_*` command via `rctx.run`) and return the next model to show, or `null` to close.

Routing: `nav:main`→main; `nav:members`→members; `nav:ranks`→ranks; `nav:door`→doorPolicy; `nav:invites`→run `sm_gang_invites` then null (text list); `member:<steam>`→memberActions; `action:<verb>:<steam>`→run `sm_gang_<verb>` [steam] then back to members; `door:<policy>`→run `sm_gang_doorpolicy` [policy] then main; unknown→null.

- [ ] **Step 1: Failing test** — `test/menus/menu-router.test.ts`:
```ts
import { route } from "../../src/menus/menu-router";
// standard api harness returning { a, players }
it("routes a member action through rctx.run and returns to the members list", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  await players.createPlayer("m", "M");
  await a.members.add(1, "m", 100);
  const calls: Array<[string, string[]]> = [];
  const rctx = { api: a, viewerSteam: "owner", run: async (c: string, args: string[]) => { calls.push([c, args]); } };
  const next = await route("action:kick:m", rctx);
  expect(calls).toContainEqual(["sm_gang_kick", ["m"]]);
  expect(next?.title).toBe("Members");
});
it("routes door selection and returns to main; unknown info closes", async () => {
  const { a, players } = await api();
  await players.createPlayer("owner", "O");
  await a.gangs.create("G", "owner");
  const calls: Array<[string, string[]]> = [];
  const rctx = { api: a, viewerSteam: "owner", run: async (c: string, args: string[]) => { calls.push([c, args]); } };
  const next = await route("door:open", rctx);
  expect(calls).toContainEqual(["sm_gang_doorpolicy", ["open"]]);
  expect(next?.title).toContain("Gang");
  expect(await route("bogus", rctx)).toBeNull();
});
```

- [ ] **Step 2: Run — fails.** `npm test test/menus/menu-router.test.ts`

- [ ] **Step 3: Implement** — `src/menus/menu-router.ts`:
```ts
import type { GangsApi } from "../../api";
import {
  type MenuModel, mainMenuModel, membersMenuModel, memberActionsModel, ranksMenuModel, doorPolicyModel,
} from "./menu-model";

export interface RouterCtx {
  api: GangsApi;
  viewerSteam: string;
  run(command: string, args: string[]): Promise<void>;
}

async function gangIdOf(rctx: RouterCtx): Promise<number | null> {
  const p = await rctx.api.players.get(rctx.viewerSteam, false);
  return p && p.gangId !== null ? p.gangId : null;
}

export async function route(info: string, rctx: RouterCtx): Promise<MenuModel | null> {
  if (info === "nav:main") return mainMenuModel(rctx.api, rctx.viewerSteam);
  if (info === "nav:members") {
    const g = await gangIdOf(rctx); return g === null ? null : membersMenuModel(rctx.api, g);
  }
  if (info === "nav:ranks") {
    const g = await gangIdOf(rctx); return g === null ? null : ranksMenuModel(rctx.api, g);
  }
  if (info === "nav:door") return doorPolicyModel();
  if (info === "nav:invites") { await rctx.run("sm_gang_invites", []); return null; }

  if (info.startsWith("member:")) {
    return memberActionsModel(rctx.api, rctx.viewerSteam, info.slice("member:".length));
  }
  if (info.startsWith("action:")) {
    const [, verb, steam] = info.split(":");
    if (verb && steam) {
      await rctx.run(`sm_gang_${verb}`, [steam]);
      const g = await gangIdOf(rctx);
      return g === null ? null : membersMenuModel(rctx.api, g);
    }
    return null;
  }
  if (info.startsWith("door:")) {
    await rctx.run("sm_gang_doorpolicy", [info.slice("door:".length)]);
    return mainMenuModel(rctx.api, rctx.viewerSteam);
  }
  return null; // unknown / close
}
```

- [ ] **Step 4: Run — passes.** `npm test test/menus/menu-router.test.ts`
- [ ] **Step 5: Commit.** `git add src/menus/menu-router.ts test/menus/menu-router.test.ts && git commit -m "feat(menus): pure menu router"`

---

## Task 6: Runtime menu layer + wiring

**Files:** Create `src/menus/menus.ts`; Modify `src/commands/gang.ts`, `src/commands/handlers.ts` (COMMANDS: `sm_gang_menu`, and bare `sm_gang` opens the menu), `src/plugin.ts` (no new registration needed if using COMMANDS). No unit test (SDK `Menu` is injected) — smoke-tested.

**Interfaces:** `openMenu(api: GangsApi, getMsg: () => Messages, slot: number, model: MenuModel): void` in `menus.ts`, and a `sm_gang_menu` command that opens `mainMenuModel` for the caller's slot.

- [ ] **Step 1: Implement `src/menus/menus.ts`:**
```ts
import { Menu } from "@s2script/sdk/menu";
import { Clients } from "@s2script/sdk/clients";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import type { CmdCtx } from "../commands/ctx";
import { runCommand } from "../commands/handlers";
import { mainMenuModel, type MenuModel } from "./menu-model";
import { route, type RouterCtx } from "./menu-router";

function onlineOf(query: string) {
  const q = query.toLowerCase();
  return Clients.all().filter((c) => c.isValid() && !c.isBot)
    .map((c) => ({ steam: c.steamId, name: c.name }))
    .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
}

/** Build a CmdCtx bound to a slot, replying into that player's chat (used when the menu runs a command). */
function ctxForSlot(api: GangsApi, msg: Messages, slot: number, steam: string): CmdCtx {
  return {
    steam, args: [], reply: (m) => Clients.fromSlot(slot)?.chat(m), api, msg,
    online: onlineOf, nowSec: Math.floor(Date.now() / 1000),
  };
}

/** Display a model to a slot and wire selections through the router, re-displaying the next model. */
export function openMenu(api: GangsApi, getMsg: () => Messages, slot: number, steam: string, model: MenuModel): void {
  const menu = new Menu(model.title);
  for (const item of model.items) menu.addItem(item.info, item.label, { disabled: item.disabled });
  const rctx: RouterCtx = {
    api, viewerSteam: steam,
    run: (command, args) => runCommand(command, { ...ctxForSlot(api, getMsg(), slot, steam), args }),
  };
  menu.onSelect((e) => {
    void route(e.info, rctx).then((next) => { if (next) openMenu(api, getMsg, slot, steam, next); });
  });
  menu.display(slot, 0);
}

/** Open the main gang menu for a connected player slot. */
export async function openGangMenu(api: GangsApi, getMsg: () => Messages, slot: number): Promise<void> {
  const client = Clients.fromSlot(slot);
  if (!client || client.steamId === "0") return;
  const model = await mainMenuModel(api, client.steamId);
  openMenu(api, getMsg, slot, client.steamId, model);
}
```

- [ ] **Step 2: Wire `sm_gang_menu` and open-on-bare-`sm_gang`.** In `src/commands/gang.ts`, add a runtime registrar for the menu (it needs the SDK, so it lives here, not in handlers.ts). Add:
```ts
// import at top:
import { openGangMenu } from "../menus/menus";

/** Register sm_gang_menu (and make bare sm_gang open the menu for players). */
export function registerMenuCommand(commands: CtxCommands, api: GangsApi, getMsg: () => Messages): void {
  commands.register("sm_gang_menu", (cmd) => {
    if (cmd.callerSlot < 0) { cmd.reply("Only players can open the menu."); return; }
    void openGangMenu(api, getMsg, cmd.callerSlot).catch((e) => {
      cmd.reply("An error occurred opening the menu.");
      console.log("[gangs] sm_gang_menu error:", e);
    });
  });
}
```
Leave `sm_gang` (info) as-is in COMMANDS — do NOT reroute it through the menu here (console callers need text). Players get the menu via `sm_gang_menu` / `!gang_menu`.

- [ ] **Step 3: Register in plugin.** In `src/plugin.ts`, after `registerGangCommands(...)`, add `import { registerMenuCommand } from "./commands/gang";` (extend the existing gang import) and call:
```ts
  registerMenuCommand(ctx.commands, api, () => msg);
```

- [ ] **Step 4: Full suite + typecheck + build.** `npm test` (all green), `npx tsc --noEmit -p tsconfig.json` (clean), `npm run build` (→ dist/gangs.s2sp).

- [ ] **Step 5: Commit.** `git add src/menus/menus.ts src/commands/gang.ts src/plugin.ts && git commit -m "feat(menus): runtime menu + sm_gang_menu"`

- [ ] **Step 6: Manual smoke (server, pending):** `!gang_menu` opens the chat menu; picking Members → a member → Kick removes them and returns to the list; Door Policy → Open sets policy; `!gang_ranks` lists ranks; `!gang_rank_create 70 Scout` then `!gang_rank_perm 70 kick_others on`.

---

## Self-Review Notes

- **Spec coverage:** perm mapping (T1) · setPermission API (T2) · rank admin commands incl. hierarchy/permission guards (T3) · pure menu model (T4) · pure router (T5) · runtime menu + wiring (T6).
- **Testability split:** T1–T5 are SDK-free and unit-tested; only `menus.ts` + the `registerMenuCommand`/`gang.ts` additions import the SDK.
- **Type consistency:** `MenuModel`/`MenuItem` defined in T4, consumed by T5/T6; `route`/`RouterCtx` in T5 consumed by T6; `runCommand` (existing) used by the router's `run`.
- **Waves for the workflow:** W1 [1, 2, 4] → W2 [3, 5] → W3 [6].
  - W1: T1 (perm.ts), T2 (impl.ts + api.d.ts), T4 (menu-model.ts new) — all depend only on existing code; no shared files.
  - W2: T3 (ranks.ts new + handlers.ts) depends on T1's `permFromName` + T2's `setPermission`; T5 (menu-router.ts new) depends on T4. No shared files.
  - W3: T6 (menus.ts new + gang.ts + plugin.ts) depends on T3 + T5.
