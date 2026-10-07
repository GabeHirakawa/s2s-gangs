import type { CmdCtx } from "./ctx";
import { requireGang, requirePlayer, gate } from "./handlers";
import { Perm } from "../domain/perm";
import { MOTD_STAT } from "../store/stats";

export function cmdPerks(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  const { perks } = ctx.gangs;
  ctx.reply("Perks:");
  for (const p of perks.all()) {
    if (p.command !== null) { ctx.reply(`  ${p.id} — ${p.name}: use !${p.command.replace(/^sm_/, "")} or the gang menu`); continue; }
    const cost = perks.nextCost(me.gangId, p.id);
    const level = perks.level(me.gangId, p.id);
    const max = p.levelled?.maxLevel ?? 0;
    const lvl = max > 1 ? ` (level ${level}/${max})` : "";
    ctx.reply(`  ${p.id} — ${p.name}${lvl}: ${cost === null ? "maxed/owned" : `${cost} credits`}`);
  }
}

export function cmdPurchase(ctx: CmdCtx): void {
  const steam = requirePlayer(ctx); if (steam === null) return;
  const perkId = (ctx.args[0] ?? "").trim();
  if (!perkId) { ctx.reply(ctx.msg.usage("!gang_purchase <perk>")); return; }
  const custom = ctx.gangs.perks.get(perkId);
  if (custom && custom.command !== null) {
    ctx.reply(`${custom.name} is managed by ${custom.provider}: use !${custom.command.replace(/^sm_/, "")}.`);
    return;
  }
  const res = ctx.gangs.perks.purchase(steam, perkId);
  switch (res.reason) {
    case "ok": ctx.reply(`Purchased ${perkId}${res.level !== undefined && res.level > 1 ? ` (level ${res.level})` : ""}. Balance: ${ctx.gangs.eco.getBalance(steam, false)}.`); break;
    case "not_ready": ctx.reply(ctx.msg.loading()); break;
    case "unknown_perk": ctx.reply(`No such perk "${perkId}". Try !gang_perks.`); break;
    case "not_in_gang": ctx.reply(ctx.msg.notInGang()); break;
    case "no_permission": ctx.reply(ctx.msg.noPermission("Purchase Perks")); break;
    case "max_level": ctx.reply("That perk cannot be purchased right now (already owned or at max level)."); break;
    case "insufficient_funds": ctx.reply(`You cannot afford that${res.cost !== undefined ? ` (${res.cost} credits)` : ""}.`); break;
  }
}

export function cmdMotd(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.MANAGE_PERKS, "Manage Perks")) return;
  if (ctx.gangs.perks.motd(me.gangId) === null) {
    ctx.reply(`Your gang must purchase the MOTD perk first (!gang_purchase ${MOTD_STAT}).`); return;
  }
  const text = ctx.args.join(" ").trim();
  if (!text) { ctx.reply(ctx.msg.usage("!gang_motd <message>")); return; }
  if (text.length > 255) { ctx.reply("That MOTD is too long (255 characters max)."); return; }
  ctx.gangs.svc.setGangStat(me.gangId, MOTD_STAT, text);
  ctx.reply("MOTD updated.");
}
