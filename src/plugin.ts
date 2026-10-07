// Gangs — the s2script runtime wiring. Everything SDK-facing lives here (and in menus/menus.ts);
// the gang state, economy, perks, api and commands are SDK-free and unit-tested.
import { command, publish, ADMFLAG, HookResult, Clients, Database, Plugins, config } from "@s2script/sdk";
import type { Client, CommandInvocation, HookResultValue } from "@s2script/sdk";
import { createGangs, type Gangs } from "./service/gangs";
import type { Emit } from "./service/events";
import { makeMessages, type Messages } from "./messages";
import { COMMANDS } from "./commands/handlers";
import type { CmdCtx, OnlinePlayer } from "./commands/ctx";
import { runCredits } from "./commands/credits";
import { openGangMenu } from "./menus/menus";
import { resolveGangChat } from "./perks/gang-chat";

let gangs: Gangs | null = null;
let msg: Messages = makeMessages("Gangs>");

function loadMessages(): void {
  msg = makeMessages(config.getString("chat_tag") || "Gangs>", config.getString("currency_name") || "credits");
}

/** Connected, authenticated, non-bot players matching a name substring or an exact SteamID. */
function online(query: string): OnlinePlayer[] {
  const q = query.toLowerCase();
  return Clients.all()
    .filter((c) => c.isValid() && !c.isBot && c.steamId !== "0")
    .map((c) => ({ steam: c.steamId, name: c.name }))
    .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
}

/** Print `line` to each online client whose SteamID is in `steamIds`. */
function deliver(steamIds: string[], line: string): void {
  const wanted = new Set(steamIds);
  for (const c of Clients.all()) if (c.isValid() && wanted.has(c.steamId)) c.chat(line);
}

function providerRunning(provider: string): boolean {
  return Plugins.list().some((p) => p.id === provider && p.state === "running");
}

function callerSteam(cmd: CommandInvocation): string | null {
  const caller = cmd.callerSlot >= 0 ? Clients.fromSlot(cmd.callerSlot) : null;
  return caller && caller.steamId !== "0" ? caller.steamId : null;
}

function buildCtx(g: Gangs, cmd: CommandInvocation): CmdCtx {
  return {
    steam: callerSteam(cmd), args: cmd.args.filter((a) => a.length > 0), reply: (m) => cmd.reply(m),
    gangs: g, msg, online, nowSec: Math.floor(Date.now() / 1000),
  };
}

function connected(client: Client): void {
  if (gangs && client.isValid() && !client.isBot && client.steamId !== "0")
    gangs.svc.playerConnected(client.steamId, client.name);
}

export function OnPluginStart(): void {
  loadMessages();
  const g = createGangs({
    log: (m) => console.log(m),
    messages: () => msg,
    providerRunning,
    deliver,
  });
  gangs = g;

  const iface = publish("@gangs/api", g.api);
  const emit: Emit = (event, payload) => { iface.emit(event, payload as never); };
  g.svc.setEmitter(emit);

  for (const c of COMMANDS) {
    command(c.name, (cmd) => {
      if (!g.svc.isReady()) { cmd.reply(msg.loading()); return HookResult.Handled; }
      // Bare `sm_gang` / `!gang` opens the interactive menu for a connected, loaded player; the
      // server console and not-yet-loaded callers get the text info handler instead.
      if (c.name === "sm_gang" && cmd.callerSlot >= 0 && openGangMenu(g, () => msg, online, cmd.callerSlot))
        return HookResult.Handled;
      try { c.run(buildCtx(g, cmd)); }
      catch (e) {
        cmd.reply("An error occurred while running that command.");
        console.log(`[gangs] ${c.name} error: ${String(e)}`);
      }
      return HookResult.Handled;
    });
  }

  command("sm_gang_menu", (cmd) => {
    if (cmd.callerSlot < 0) { cmd.reply("Only players can open the menu."); return HookResult.Handled; }
    if (!openGangMenu(g, () => msg, online, cmd.callerSlot)) cmd.reply(msg.loading());
    return HookResult.Handled;
  });

  command.admin("sm_credits", ADMFLAG.ROOT, (cmd) => {
    if (!g.svc.isReady()) { cmd.reply(msg.loading()); return HookResult.Handled; }
    try { runCredits({ args: cmd.args.filter((a) => a.length > 0), reply: (m) => cmd.reply(m), gangs: g, msg, online }); }
    catch (e) {
      cmd.reply("An error occurred while running that command.");
      console.log(`[gangs] sm_credits error: ${String(e)}`);
    }
    return HookResult.Handled;
  });

  // Live-reload the chat tag / currency name; handlers read `msg` per invocation.
  config.onChange(() => { loadMessages(); });

  const prefix = config.getString("table_prefix") || "gang";
  const connection = config.getString("db_connection") || "default";
  g.svc.start(() => Database.open(connection), prefix);

  // Hot (re)load: players already on the server get loaded too (queued after the boot load).
  for (const c of Clients.all()) connected(c);
}

export function OnPluginEnd(): void {
  const g = gangs;
  gangs = null;
  if (g) void g.svc.shutdown().catch((e: unknown) => console.log(`[gangs] shutdown: ${String(e)}`));
}

export function OnClientPutInServer(client: Client): void { connected(client); }

/** SteamID is guaranteed after auth; PutInServer may still see "0". Both are idempotent. */
export function OnClientPostAdminCheck(client: Client): void { connected(client); }

export function OnClientDisconnect(client: Client): void {
  if (gangs && client.steamId !== "0") gangs.svc.playerDisconnected(client.steamId);
}

/**
 * Gang chat: `.message` from an eligible member (perk owned + SEND_GANG_CHAT) goes to online gang
 * members only and is suppressed from public chat. Anything else — including an ineligible `.`
 * message — falls through as normal chat.
 */
export function OnClientSayCommand(slot: number, text: string, _teamonly: boolean): HookResultValue {
  if (!gangs || !gangs.svc.isReady() || !text.startsWith(".")) return HookResult.Continue;
  const client = Clients.fromSlot(slot);
  if (!client || client.isBot || client.steamId === "0") return HookResult.Continue;
  const delivery = resolveGangChat(gangs, msg, client.steamId, text);
  if (!delivery) return HookResult.Continue;
  deliver(delivery.recipients, delivery.line);
  return HookResult.Handled;
}
