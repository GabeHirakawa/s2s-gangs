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
