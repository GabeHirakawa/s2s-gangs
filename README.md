# Gangs for s2script

A port of [edgegamers/Gangs](https://github.com/edgegamers/Gangs) (C# / CounterStrikeSharp) to
[s2script](https://s2script.com) for Counter-Strike 2: player gangs with ranks and permissions,
invitations and a door policy, a credits economy with a gang bank, purchasable perks (capacity,
gang chat, MOTD, plus perks contributed by other plugins), interactive menus, and a typed
cross-plugin service, **`@gangs/api`**.

Built against `@s2script/sdk` **0.27** and `@s2script/cs2` **0.19** with **interop protocol 2**
(host API 3).

## Build & test

```bash
npm install
npx vitest run        # SDK-free unit tests (cache, write queue, api, commands, menus) against SQLite
npx s2s build .       # typecheck + lint + contract check → dist/_gangs_api.s2sp
```

Drop `dist/_gangs_api.s2sp` into `addons/s2script/plugins/`. The plugin id is the package name,
`@gangs/api`.

## Configuration

| key | default | meaning |
|---|---|---|
| `table_prefix` | `gang` | prefix of every table (`gang_gangs`, `gang_players`, …) |
| `db_connection` | `default` | named connection passed to `Database.open` |
| `currency_name` | `credits` | word used for credits in replies (live-reloaded) |
| `chat_tag` | `Gangs>` | prefix of plugin replies (live-reloaded) |

## Commands

| command | who | what |
|---|---|---|
| `sm_gang` / `!gang` | player | open the gang menu (console: gang info) |
| `sm_gang_menu` | player | open the gang menu |
| `sm_gang_create <name>` | player | create a gang (you become owner) |
| `sm_gang_rename <name>` | owner | rename the gang |
| `sm_gang_invite <player>` | INVITE_OTHERS | invite an online player |
| `sm_gang_invites` / `sm_gang_pending` | member / player | outgoing / incoming invites |
| `sm_gang_join <gang>` | player | join (invite required unless the door policy is open; capacity enforced) |
| `sm_gang_leave` | member | leave (owners must transfer or disband) |
| `sm_gang_kick` / `_promote` / `_demote <member>` | KICK / PROMOTE / DEMOTE_OTHERS | manage lower ranks |
| `sm_gang_transfer <member>` | owner | hand over ownership |
| `sm_gang_members` / `sm_gang_ranks` | member | list |
| `sm_gang_rank_create <#> <name>` | CREATE_RANKS | add a rank below yours |
| `sm_gang_rank_rename <#> <name>` / `_rank_delete <#>` | MANAGE_RANKS | edit lower ranks |
| `sm_gang_rank_perm <#> <perm> <on\|off>` | MANAGE_RANKS | toggle a permission you hold |
| `sm_gang_doorpolicy <open\|invite\|request>` | MANAGE_RANKS | who may join |
| `sm_gang_perks` / `sm_gang_purchase <perk>` | member / PURCHASE_PERKS | list / buy perks |
| `sm_gang_motd <text>` | MANAGE_PERKS | set the MOTD (perk required) |
| `sm_gang_balance` / `sm_gang_deposit <n\|all>` | player / BANK_DEPOSIT | credits |
| `sm_gang_disband confirm` | owner | delete the gang |
| `sm_gang_help` | anyone | list commands |
| `sm_credits <player> <amount> [reason]` | admin ROOT | grant/take wallet credits |

Gang chat: once the gang owns the **Gang Chat** perk, a member whose rank holds `SEND_GANG_CHAT`
types `.message` to talk to online gang members. Any other `.` message is ordinary public chat.

## `@gangs/api` (1.0.0)

The contract is [`api.d.ts`](api.d.ts) — self-contained, protocol 2. **Every method is
synchronous** and answers from Gangs' in-memory cache; writes update the cache immediately and are
persisted in the background. Until the initial load finishes `isReady()` is false, reads return
empty/null/0 and writes return false; `OnReady` fires once it flips.

```jsonc
// your plugin's package.json
"s2script": {
  "interfaceProtocol": 2,
  "optionalPluginDependencies": { "@gangs/api": "^1.0.0" }
}
```

```bash
npx s2s add @gangs/api   # vendors the verified api.d.ts into .s2script/types/
```

```ts
// (this snippet is verified to build as a protocol-2 consumer with s2s build)
import { watchOptional, pluginId } from "@s2script/sdk";

export function OnPluginStart(): void {
  const me = pluginId();
  watchOptional("@gangs/api", (gangs) => {
    const register = (): void => {
      gangs.registerPerk(me, { id: "smoke", name: "Smoke Color", description: "Coloured smokes", costs: [5000, 10000] });
    };
    gangs.on("OnReady", register);
    if (gangs.isReady()) register();      // already loaded when we attached
    gangs.on("OnMemberJoined", (e) => console.log(`${e.steamId} joined gang ${e.gangId}`));
  });
}
```

Notes for consumers:

- Players are canonical decimal SteamID64 strings; gangs are positive integer ids.
- Gang members are always cached; other players only while online (after their connect load).
  Player-scoped writes (`setPlayerStat`, `grantPlayer`, `tryPurchase`) for a player who is neither
  return false / -1.
- Balances never go below zero: a negative grant is clamped, and `OnBalanceChanged.delta` is the
  change actually applied. `-1` is therefore always "could not" (not ready, unknown target, invalid
  amount, unaffordable).
- `setGangStat`/`setPlayerStat` refuse `gang_native_balance` (use `grantGang`/`grantPlayer`, which
  emit events) and type-check Gangs' own native stats. Upstream record stats (invitations) are
  readable as JSON text but not writable.
- External perks are in-memory: re-register on every `OnReady` (Gangs reloads drop them). They are
  listed only while the provider plugin is running.
- `OnGangCreated` is followed by `OnMemberJoined` for the owner (rank 0). Disbanding emits
  `OnMemberLeft` (`reason: "disband"`) for each member, then `OnGangDisbanded`.

### Migrating from 0.x

0.x was protocol 1: a namespaced, **Promise-returning** object obtained with
`ctx.use<GangsApi>("@gangs/api")`, with snake_case events (`member_joined`, …). 1.0.0 is a breaking
redesign: flat synchronous methods, PascalCase protocol-2 forwards, `Gang.id` instead of `gangId`,
`Member` instead of `GangPlayer`. Rebuild consumers against the new `api.d.ts` with
`interfaceProtocol: 2` and `^1.0.0`; drop every `await` on Gangs calls. Rank/invite/gang mutation
methods are no longer part of the service — they are Gangs' own commands and menus.

## Layout

```
api.d.ts                 the @gangs/api protocol-2 contract (the distributable types)
src/plugin.ts            runtime wiring: OnPluginStart, publish, commands, client publics, gang chat
src/menus/menus.ts       SDK Menu rendering (runtime only)
src/service/             GangService (cache + mutations + forwards), composition root, forward types
src/store/               SQL repo (upstream schema), stat descriptors/codecs, ordered WriteQueue
src/eco/economy.ts       wallet / gang bank / bank-first purchases
src/perks/               perk catalog (native + external), gang-chat resolver
src/api/impl.ts          the synchronous, input-validating @gangs/api implementation
src/commands/            SDK-free command handlers
src/menus/menu-*.ts      SDK-free menu models + router
test/                    vitest suite (better-sqlite3)
```

## Database

Upstream-compatible tables: `<p>_gangs`, `<p>_players`, `<p>_ranks`, and one instance table per
native stat (`<p>_gang_stats_<id>`, `<p>_player_stats_<id>`). Any other stat id (for example the
`perk:<id>` levels of external perks) lives in `<p>_gang_stat_values` / `<p>_player_stat_values`
as JSON text. New gangs get `max(id)+1` with an explicit id.

## Not verified

Nothing here has run on a live CS2 server: the unit suite and `s2s build` gate are offline. In
particular gang chat suppression, menu rendering, `fakeCommand` for custom perks, and the SQL against
MySQL/Postgres (the repo uses SQLite-style `ON CONFLICT` upserts and backtick-quoted `Rank`) are
unverified. See `docs/superpowers/specs/2026-10-07-sdk-0.27-port-design.md`.
