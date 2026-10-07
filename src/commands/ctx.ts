import type { Gangs } from "../service/gangs";
import type { Messages } from "../messages";

export interface OnlinePlayer { steam: string; name: string; }

/** Everything a (synchronous, SDK-free) command handler needs. */
export interface CmdCtx {
  steam: string | null;                 // caller SteamID64, null for console / unauthenticated
  args: string[];                       // whitespace-split args after the command name
  reply(message: string): void;
  gangs: Gangs;
  msg: Messages;
  online(query: string): OnlinePlayer[]; // resolve currently-connected players
  nowSec: number;                       // current unix seconds (injected; keeps handlers pure)
}
