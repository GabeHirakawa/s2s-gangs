import type { CommandInvocation } from "@s2script/sdk/commands";
import { Clients } from "@s2script/sdk/clients";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import { dispatch } from "./handlers";
import type { CmdCtx, OnlinePlayer } from "./ctx";

/** Build a CmdCtx from a runtime CommandInvocation and run the matching subcommand. */
export function runGangCommand(api: GangsApi, msg: Messages, cmd: CommandInvocation): void {
  const caller = cmd.callerSlot >= 0 ? Clients.fromSlot(cmd.callerSlot) : null;
  const steam = caller && caller.steamId !== "0" ? caller.steamId : null;
  const sub = cmd.arg(0);
  const args = cmd.argsFrom(1).length ? cmd.argsFrom(1).split(/\s+/) : [];

  const online = (query: string): OnlinePlayer[] => {
    const q = query.toLowerCase();
    return Clients.all()
      .filter((c) => c.isValid() && !c.isBot)
      .map((c) => ({ steam: c.steamId, name: c.name }))
      .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
  };

  const ctx: CmdCtx = {
    steam, args, reply: (m) => cmd.reply(m), api, msg, online,
    nowSec: Math.floor(Date.now() / 1000),
  };
  // Design §7: wrap the command path so a thrown invariant/DB error replies + logs, never an
  // unhandled rejection. CommandInvocation is documented safe to reply after an await.
  dispatch(ctx, sub).catch((e) => {
    cmd.reply("An error occurred while running that command.");
    console.log("[gangs] command error:", e);
  });
}
