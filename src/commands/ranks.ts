import type { CmdCtx } from "./ctx";
import { requireGang, gate } from "./handlers";
import { Perm, hasPerm, describe, permFromName, EDITABLE_PERMS } from "../domain/perm";
import { DeleteStrat } from "../domain/types";

function parseRank(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && String(n) === raw && n >= 0 ? n : null;
}

export async function cmdRanks(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const ranks = await ctx.api.ranks.getAll(me.gangId);
  ctx.reply("Ranks:");
  for (const r of ranks) ctx.reply(`  [${r.rank}] ${r.name} — ${describe(r.permissions)}`);
}

export async function cmdRankCreate(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.CREATE_RANKS, "Create Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const name = ctx.args.slice(1).join(" ").trim();
  if (rank === null || !name) { ctx.reply(ctx.msg.usage("!gang_rank_create <rank#> <name>")); return; }
  if (rank <= me.rank) { ctx.reply("You can only create ranks below your own."); return; }
  const made = await ctx.api.ranks.create(me.gangId, name, rank, Perm.NONE);
  ctx.reply(made ? `Created rank [${rank}] ${name}.` : "That rank number already exists.");
}

export async function cmdRankRename(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  const name = ctx.args.slice(1).join(" ").trim();
  if (rank === null || !name) { ctx.reply(ctx.msg.usage("!gang_rank_rename <rank#> <name>")); return; }
  if (rank <= me.rank) { ctx.reply("You cannot edit your own or a higher rank."); return; }
  const existing = await ctx.api.ranks.get(me.gangId, rank);
  if (!existing) { ctx.reply("No such rank."); return; }
  const ok = await ctx.api.ranks.update(me.gangId, { ...existing, name });
  ctx.reply(ok ? `Renamed rank [${rank}] to ${name}.` : "Failed to rename.");
}

export async function cmdRankDelete(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const rank = parseRank(ctx.args[0] ?? "");
  if (rank === null) { ctx.reply(ctx.msg.usage("!gang_rank_delete <rank#>")); return; }
  if (rank <= me.rank) { ctx.reply("You cannot delete your own or a higher rank."); return; }
  const ok = await ctx.api.ranks.delete(me.gangId, rank, DeleteStrat.DEMOTE_FAIL);
  ctx.reply(ok ? `Deleted rank [${rank}].` : "Could not delete that rank (it may not exist or have members with no lower rank).");
}

export async function cmdRankPerm(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
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
  const mine = await ctx.api.ranks.get(me.gangId, me.rank);
  if (!mine || !hasPerm(mine.permissions, perm)) {
    ctx.reply(`You cannot ${on ? "grant" : "revoke"} a permission you do not have.`);
    return;
  }
  const ok = await ctx.api.ranks.setPermission(me.gangId, rank, perm, on);
  ctx.reply(ok ? `${on ? "Granted" : "Revoked"} ${ctx.args[1]} on rank [${rank}].` : "No such rank.");
}
