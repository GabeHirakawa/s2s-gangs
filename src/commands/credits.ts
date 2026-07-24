// Pure, SDK-free so it is unit-testable off-runtime (mirrors handlers.ts vs gang.ts).
// The runtime entry `runCreditsCommand` lives in gang.ts, which owns the SDK imports.
import type { GangsApi } from "../../api";
import type { OnlinePlayer } from "./ctx";

export interface CreditsCtx {
  args: string[];
  reply(message: string): void;
  api: GangsApi;
  online(query: string): OnlinePlayer[];
}

/** Admin: grant (or, with a negative amount, take) credits from a uniquely-resolved online player. */
export async function runCredits(ctx: CreditsCtx): Promise<void> {
  if (ctx.args.length < 2) { ctx.reply("Usage: sm_credits <player> <amount> [reason]"); return; }
  const matches = ctx.online(ctx.args[0]);
  if (matches.length !== 1) { ctx.reply(`Could not find a unique player for "${ctx.args[0]}".`); return; }
  const raw = ctx.args[1];
  const amount = parseInt(raw, 10);
  if (!Number.isInteger(amount) || String(amount) !== raw.replace(/^\+/, "")) {
    ctx.reply("Amount must be an integer."); return;
  }
  const reason = ctx.args.slice(2).join(" ") || "admin";
  const target = matches[0];
  await ctx.api.players.create(target.steam, target.name);
  const balance = await ctx.api.eco.grantPlayer(target.steam, amount, reason);
  ctx.reply(`${target.name} now has ${balance} credits.`);
}
