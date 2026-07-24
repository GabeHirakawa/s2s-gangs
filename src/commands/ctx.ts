import type { GangsApi } from "../../api";
import type { Messages } from "../messages";

export interface OnlinePlayer { steam: string; name: string; }

export interface CmdCtx {
  steam: string | null;                 // caller SteamID64, null for console
  args: string[];                       // args after the subcommand
  reply(message: string): void;
  api: GangsApi;
  msg: Messages;
  online(query: string): OnlinePlayer[]; // resolve currently-connected players
  nowSec: number;                       // current unix seconds (injected; keeps handlers pure)
}
