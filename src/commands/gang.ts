import type { CommandInvocation } from "@s2script/sdk/commands";
import type { CtxCommands } from "@s2script/sdk/plugin";
import { Clients } from "@s2script/sdk/clients";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import { COMMANDS } from "./handlers";
import type { CmdCtx, OnlinePlayer } from "./ctx";

/** Resolve currently-connected players matching a name substring or an exact SteamID. */
function online(query: string): OnlinePlayer[] {
  const q = query.toLowerCase();
  return Clients.all()
    .filter((c) => c.isValid() && !c.isBot)
    .map((c) => ({ steam: c.steamId, name: c.name }))
    .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
}

/** Build a CmdCtx from a runtime CommandInvocation. `args` are everything after the command name. */
function buildCtx(api: GangsApi, msg: Messages, cmd: CommandInvocation): CmdCtx {
  const caller = cmd.callerSlot >= 0 ? Clients.fromSlot(cmd.callerSlot) : null;
  const steam = caller && caller.steamId !== "0" ? caller.steamId : null;
  const args = cmd.argString.length ? cmd.argString.split(/\s+/) : [];
  return { steam, args, reply: (m) => cmd.reply(m), api, msg, online, nowSec: Math.floor(Date.now() / 1000) };
}

/**
 * Register every gang command individually with the engine (sm_gang, sm_gang_create, …). Each is a
 * real console command; chat "!gang_create" resolves to "sm_gang_create". No central dispatcher.
 */
export function registerGangCommands(commands: CtxCommands, api: GangsApi, getMsg: () => Messages): void {
  for (const c of COMMANDS) {
    commands.register(c.name, (cmd) => {
      // Wrap the command path so a thrown invariant/DB error replies + logs, never an unhandled rejection.
      // getMsg() is read per-invocation so a live chat_tag reload takes effect.
      c.run(buildCtx(api, getMsg(), cmd)).catch((e) => {
        cmd.reply("An error occurred while running that command.");
        console.log(`[gangs] ${c.name} error:`, e);
      });
    });
  }
}
