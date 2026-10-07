// Pure, SDK-free so it is unit-testable off-runtime. The runtime entry lives in plugin.ts.
import type { Gangs } from "../service/gangs";
import type { Messages } from "../messages";
import type { OnlinePlayer } from "./ctx";

export interface CreditsCtx {
  args: string[];
  reply(message: string): void;
  gangs: Gangs;
  msg: Messages;
  online(query: string): OnlinePlayer[];
}

/** Admin: grant (or, with a negative amount, take) credits from a uniquely-resolved online player. */
export function runCredits(ctx: CreditsCtx): void {
  if (ctx.args.length < 2) { ctx.reply("Usage: sm_credits <player> <amount> [reason]"); return; }
  const matches = ctx.online(ctx.args[0]);
  if (matches.length !== 1) { ctx.reply(`Could not find a unique player for "${ctx.args[0]}".`); return; }
  const raw = ctx.args[1];
  const amount = parseInt(raw, 10);
  if (!Number.isSafeInteger(amount) || String(amount) !== raw.replace(/^\+/, "")) {
    ctx.reply("Amount must be an integer."); return;
  }
  const reason = ctx.args.slice(2).join(" ") || "admin";
  const target = matches[0];
  if (!ctx.gangs.svc.isLoaded(target.steam)) { ctx.reply(ctx.msg.loading()); return; }
  const balance = ctx.gangs.eco.grantPlayer(target.steam, amount, reason);
  ctx.reply(balance < 0 ? "Failed to grant credits." : `${target.name} now has ${balance} credits.`);
}
