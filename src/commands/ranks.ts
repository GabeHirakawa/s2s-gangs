import type { CmdCtx } from "./ctx";
import { requireGang, gate } from "./handlers";
import { Perm, hasPerm, describe, permFromName, EDITABLE_PERMS } from "../domain/perm";
import { DeleteStrat } from "../domain/types";

function parseRank(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isSafeInteger(n) && String(n) === raw && n >= 0 ? n : null;
}

export function cmdRanks(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  ctx.reply("Ranks:");
  for (const r of ctx.gangs.svc.ranksOf(me.gangId)) ctx.reply(`  [${r.rank}] ${r.name} — ${describe(r.permissions)}`);
}

export function cmdRankCreate(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.CREATE_RANKS, "Create Ranks")) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const name = ctx.args.slice(1).join(" ").trim();
  if (rank === null || !name) { ctx.reply(ctx.msg.usage("!gang_rank_create <rank#> <name>")); return; }
  if (rank <= me.rank) { ctx.reply("You can only create ranks below your own."); return; }
  const made = ctx.gangs.svc.createRank(me.gangId, name, rank, Perm.NONE);
  ctx.reply(made ? `Created rank [${rank}] ${name}.` : "That rank number already exists.");
}

export function cmdRankRename(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks")) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const name = ctx.args.slice(1).join(" ").trim();
  if (rank === null || !name) { ctx.reply(ctx.msg.usage("!gang_rank_rename <rank#> <name>")); return; }
  if (rank <= me.rank) { ctx.reply("You cannot edit your own or a higher rank."); return; }
  const existing = ctx.gangs.svc.getRank(me.gangId, rank);
  if (!existing) { ctx.reply("No such rank."); return; }
  const ok = ctx.gangs.svc.updateRank(me.gangId, { ...existing, name });
  ctx.reply(ok ? `Renamed rank [${rank}] to ${name}.` : "Failed to rename.");
}

export function cmdRankDelete(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks")) return;
  const rank = parseRank(ctx.args[0] ?? "");
  if (rank === null) { ctx.reply(ctx.msg.usage("!gang_rank_delete <rank#>")); return; }
  if (rank <= me.rank) { ctx.reply("You cannot delete your own or a higher rank."); return; }
  const ok = ctx.gangs.svc.deleteRank(me.gangId, rank, DeleteStrat.DEMOTE_FAIL);
  ctx.reply(ok ? `Deleted rank [${rank}].` : "Could not delete that rank (it may not exist or have members with no lower rank).");
}

export function cmdRankPerm(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks")) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const perm = permFromName(ctx.args[1] ?? "");
  const toggle = (ctx.args[2] ?? "").toLowerCase();
  if (rank === null || perm === null || (toggle !== "on" && toggle !== "off")) {
    ctx.reply(ctx.msg.usage(`!gang_rank_perm <rank#> <${EDITABLE_PERMS.map((p) => p.name).join("|")}> <on|off>`));
    return;
  }
  if (rank <= me.rank) { ctx.reply("You cannot edit your own or a higher rank."); return; }
  const on = toggle === "on";
  // The caller may only grant or revoke a permission they hold themselves. This mirrors upstream, where
  // the perm-edit menu only offers the flags the editor has; it stops a Manager who lacks a perm from
  // either handing it out or stripping it from a lower rank.
  const mine = ctx.gangs.svc.getRank(me.gangId, me.rank);
  if (!mine || !hasPerm(mine.permissions, perm)) {
    ctx.reply(`You cannot ${on ? "grant" : "revoke"} a permission you do not have.`);
    return;
  }
  const ok = ctx.gangs.svc.setRankPermission(me.gangId, rank, perm, on);
  ctx.reply(ok ? `${on ? "Granted" : "Revoked"} ${ctx.args[1]} on rank [${rank}].` : "No such rank.");
}
