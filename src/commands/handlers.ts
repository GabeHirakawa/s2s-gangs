import type { CmdCtx } from "./ctx";
export type { CmdCtx, OnlinePlayer } from "./ctx";
import { Perm } from "../domain/perm";
import { DoorPolicy } from "../domain/types";
import { DOOR_POLICY_STAT } from "../store/stats";
import { cmdRanks, cmdRankCreate, cmdRankRename, cmdRankDelete, cmdRankPerm } from "./ranks";
import { cmdPerks, cmdPurchase, cmdMotd } from "./perks";

/** The caller's SteamID, or null after replying (console caller / data still loading). */
export function requirePlayer(ctx: CmdCtx): string | null {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return null; }
  if (!ctx.gangs.svc.isLoaded(ctx.steam)) { ctx.reply(ctx.msg.loading()); return null; }
  return ctx.steam;
}

export function requireGang(ctx: CmdCtx): { steam: string; gangId: number; rank: number } | null {
  const steam = requirePlayer(ctx); if (steam === null) return null;
  const p = ctx.gangs.svc.getPlayer(steam);
  if (!p || p.gangId === null || p.gangRank === null) { ctx.reply(ctx.msg.notInGang()); return null; }
  return { steam, gangId: p.gangId, rank: p.gangRank };
}

export function gate(ctx: CmdCtx, steam: string, perm: number, node: string): boolean {
  if (ctx.gangs.svc.hasPermission(steam, perm)) return true;
  ctx.reply(ctx.msg.noPermission(node));
  return false;
}

const nameOf = (p: { steam: string; name: string | null }): string => p.name ?? p.steam;

function cmdCreate(ctx: CmdCtx): void {
  const steam = requirePlayer(ctx); if (steam === null) return;
  const name = ctx.args.join(" ").trim();
  if (!name) { ctx.reply(ctx.msg.usage("!gang_create <name>")); return; }
  const { svc } = ctx.gangs;
  if (svc.getPlayer(steam)?.gangId != null) { ctx.reply(ctx.msg.alreadyInGang()); return; }
  if (svc.isNameTaken(name)) { ctx.reply(ctx.msg.nameTaken(name)); return; }
  const gang = svc.createGang(name, steam);
  ctx.reply(gang ? ctx.msg.created(gang.name, gang.gangId) : "Failed to create gang.");
}

function cmdRename(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  const name = ctx.args.join(" ").trim();
  if (!name) { ctx.reply(ctx.msg.usage("!gang_rename <name>")); return; }
  if (ctx.gangs.svc.isNameTaken(name, me.gangId)) { ctx.reply(ctx.msg.nameTaken(name)); return; }
  ctx.reply(ctx.gangs.svc.renameGang(me.gangId, name) ? ctx.msg.renamed(name.trim()) : "Failed to rename the gang.");
}

function cmdInvite(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.INVITE_OTHERS, "Invite Others")) return;
  const { svc } = ctx.gangs;
  const query = ctx.args.join(" ").trim();
  const matches = query ? ctx.online(query) : [];
  if (matches.length !== 1) { ctx.reply(ctx.msg.playerNotFound(query)); return; }
  const target = matches[0];
  if (svc.getPlayer(target.steam)?.gangId != null) { ctx.reply(`${target.name} is already in a gang.`); return; }
  svc.createInvite(me.gangId, me.steam, target.steam, ctx.nowSec);
  ctx.reply(ctx.msg.invited(target.name, svc.getGang(me.gangId)?.name ?? String(me.gangId)));
}

function cmdInvites(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  const list = ctx.gangs.svc.outgoingInvites(me.gangId);
  ctx.reply(list.length ? `Outgoing invites: ${list.join(", ")}` : "Your gang has not invited anyone.");
}

function cmdPending(ctx: CmdCtx): void {
  const steam = requirePlayer(ctx); if (steam === null) return;
  const { svc } = ctx.gangs;
  const gangs = svc.pendingInvites(steam);
  if (!gangs.length) { ctx.reply("You have no pending invites."); return; }
  const names = gangs.map((id) => svc.getGang(id)?.name ?? `#${id}`);
  ctx.reply(`Invited by: ${names.join(", ")}. Use !gang_join <name> to accept.`);
}

function cmdJoin(ctx: CmdCtx): void {
  const steam = requirePlayer(ctx); if (steam === null) return;
  const { svc, perks } = ctx.gangs;
  if (svc.getPlayer(steam)?.gangId != null) { ctx.reply(ctx.msg.alreadyInGang()); return; }
  const gang = svc.findGangByName(ctx.args.join(" "));
  if (!gang) { ctx.reply("Could not find that gang."); return; }

  const raw = svc.gangStat(gang.gangId, DOOR_POLICY_STAT);
  const policy = typeof raw === "number" ? raw : DoorPolicy.REQUEST_ONLY;
  const invited = svc.outgoingInvites(gang.gangId).includes(steam);
  // OPEN lets anyone in; every other policy requires an invite (request-to-join is deferred).
  if (policy !== DoorPolicy.OPEN && !invited) { ctx.reply("You need an invite to join this gang."); return; }

  const joinRank = svc.joinRank(gang.gangId);
  if (!joinRank) { ctx.reply("Failed to join."); return; }
  if (svc.memberCount(gang.gangId) >= perks.capacity(gang.gangId)) { ctx.reply("That gang is full."); return; }
  if (!svc.addMember(gang.gangId, steam, joinRank.rank)) { ctx.reply("Failed to join."); return; }
  if (invited) svc.revokeInvite(gang.gangId, steam);
  ctx.reply(ctx.msg.joined(gang.name));
}

function cmdLeave(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (me.rank === 0) { ctx.reply("Owners must transfer or disband, not leave."); return; }
  const p = ctx.gangs.svc.getPlayer(me.steam);
  ctx.gangs.svc.removeMember(me.steam, "leave");
  ctx.reply(ctx.msg.left(p ? nameOf(p) : me.steam));
}

function cmdKick(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.KICK_OTHERS, "Kick Others")) return;
  const query = ctx.args.join(" ");
  const target = ctx.gangs.svc.findInGang(me.gangId, query);
  if (!target || target.gangRank === null) { ctx.reply(ctx.msg.playerNotFound(query)); return; }
  if (target.gangRank <= me.rank) { ctx.reply("You cannot kick someone of equal or higher rank."); return; }
  ctx.gangs.svc.removeMember(target.steam, "kick");
  ctx.reply(ctx.msg.kicked(nameOf(target)));
}

function changeRank(ctx: CmdCtx, dir: "promote" | "demote"): void {
  const me = requireGang(ctx); if (!me) return;
  const perm = dir === "promote" ? Perm.PROMOTE_OTHERS : Perm.DEMOTE_OTHERS;
  if (!gate(ctx, me.steam, perm, dir === "promote" ? "Promote Others" : "Demote Others")) return;
  const { svc } = ctx.gangs;
  const query = ctx.args.join(" ");
  const target = svc.findInGang(me.gangId, query);
  if (!target || target.gangRank === null) { ctx.reply(ctx.msg.playerNotFound(query)); return; }
  if (target.gangRank <= me.rank) { ctx.reply("You cannot change the rank of someone equal or above you."); return; }
  const ranks = svc.ranksOf(me.gangId);
  const sorted = ranks.map((r) => r.rank);
  const idx = sorted.indexOf(target.gangRank);
  const nextRank = dir === "promote" ? sorted[idx - 1] : sorted[idx + 1];
  if (nextRank === undefined) { ctx.reply("No rank to move to."); return; }
  if (dir === "promote" && nextRank <= me.rank) { ctx.reply("You cannot promote above yourself."); return; }
  svc.setMemberRank(target.steam, nextRank);
  const rankName = ranks.find((r) => r.rank === nextRank)?.name ?? String(nextRank);
  ctx.reply(dir === "promote" ? ctx.msg.promoted(nameOf(target), rankName) : ctx.msg.demoted(nameOf(target), rankName));
}

function cmdTransfer(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  const { svc } = ctx.gangs;
  const query = ctx.args.join(" ");
  const target = svc.findInGang(me.gangId, query);
  if (!target || target.gangRank === null || target.steam === me.steam) {
    ctx.reply(ctx.msg.playerNotFound(query)); return;
  }
  const joinRank = svc.joinRank(me.gangId);
  svc.setMemberRank(target.steam, 0);
  svc.setMemberRank(me.steam, joinRank?.rank ?? me.rank);
  ctx.reply(`Transferred ownership to ${nameOf(target)}.`);
}

function cmdMembers(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  const { svc } = ctx.gangs;
  const ranks = svc.ranksOf(me.gangId);
  const rankName = (n: number | null): string => ranks.find((r) => r.rank === n)?.name ?? "?";
  ctx.reply("Members:");
  for (const m of svc.membersOf(me.gangId)) ctx.reply(ctx.msg.memberLine(nameOf(m), rankName(m.gangRank)));
}

function cmdDoorPolicy(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks")) return;
  const map: Record<string, DoorPolicy> = {
    open: DoorPolicy.OPEN, invite: DoorPolicy.INVITE_ONLY, request: DoorPolicy.REQUEST_ONLY,
  };
  const key = (ctx.args[0] ?? "").toLowerCase();
  const choice = map[key];
  if (choice === undefined) { ctx.reply(ctx.msg.usage("!gang_doorpolicy <open|invite|request>")); return; }
  ctx.gangs.svc.setGangStat(me.gangId, DOOR_POLICY_STAT, choice);
  ctx.reply(`Door policy set to ${key}.`);
}

function cmdDisband(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  if ((ctx.args[0] ?? "").toLowerCase() !== "confirm") { ctx.reply(ctx.msg.disbandWarning()); return; }
  const { svc } = ctx.gangs;
  const name = svc.getGang(me.gangId)?.name ?? String(me.gangId);
  svc.disbandGang(me.gangId);
  ctx.reply(ctx.msg.disbanded(name));
}

function cmdInfo(ctx: CmdCtx): void {
  const steam = requirePlayer(ctx); if (steam === null) return;
  const { svc } = ctx.gangs;
  const gang = svc.gangOf(steam);
  const rank = svc.rankOfMember(steam);
  if (!gang || !rank) { ctx.reply(ctx.msg.notInGang()); return; }
  ctx.reply(`${gang.name} — your rank: ${rank.name} — members: ${svc.memberCount(gang.gangId)}`);
}

function cmdBalance(ctx: CmdCtx): void {
  const steam = requirePlayer(ctx); if (steam === null) return;
  const { svc, eco } = ctx.gangs;
  ctx.reply(ctx.msg.balance(eco.getBalance(steam, true)));
  const gang = svc.gangOf(steam);
  if (gang) ctx.reply(ctx.msg.gangBalance(gang.name, eco.getGangBalance(gang.gangId)));
}

function cmdDeposit(ctx: CmdCtx): void {
  const me = requireGang(ctx); if (!me) return;
  if (!gate(ctx, me.steam, Perm.BANK_DEPOSIT, "Deposit Money")) return;
  const { eco } = ctx.gangs;
  const raw = (ctx.args[0] ?? "").toLowerCase();
  let amount: number;
  if (raw === "all") {
    amount = eco.getBalance(me.steam, true);
    if (amount <= 0) { ctx.reply(ctx.msg.noCredits()); return; }
  } else {
    amount = parseInt(raw, 10);
    if (!Number.isSafeInteger(amount) || String(amount) !== raw.replace(/^\+/, "") || amount <= 0) {
      ctx.reply(ctx.msg.usage("!gang_deposit <amount|all>")); return;
    }
  }
  const wallet = eco.getBalance(me.steam, true);
  if (eco.tryPurchase(me.steam, amount, "deposit", true) < 0) { ctx.reply(ctx.msg.cannotAfford(amount - wallet)); return; }
  eco.grantGang(me.gangId, amount, "deposit");
  ctx.reply(ctx.msg.deposited(amount));
}

function cmdHelp(ctx: CmdCtx): void {
  // Derived from COMMANDS: "!gang_create, !gang_invite, …" (the bare !gang omitted).
  const names = [...COMMANDS.map((c) => c.name), "sm_gang_menu"]
    .map((n) => "!" + n.slice("sm_".length))
    .filter((n) => n !== "!gang").join(", ");
  ctx.reply(ctx.msg.usage(names));
}

/** One registered command. `name` is the engine command (e.g. "sm_gang_create"); chat "!gang_create"
 *  resolves to it. Each is registered individually — there is no central subcommand dispatcher. */
export interface GangCommand {
  name: string;
  run: (ctx: CmdCtx) => void;
}

export const COMMANDS: GangCommand[] = [
  { name: "sm_gang", run: cmdInfo },
  { name: "sm_gang_create", run: cmdCreate },
  { name: "sm_gang_rename", run: cmdRename },
  { name: "sm_gang_invite", run: cmdInvite },
  { name: "sm_gang_invites", run: cmdInvites },
  { name: "sm_gang_pending", run: cmdPending },
  { name: "sm_gang_join", run: cmdJoin },
  { name: "sm_gang_leave", run: cmdLeave },
  { name: "sm_gang_kick", run: cmdKick },
  { name: "sm_gang_promote", run: (ctx) => changeRank(ctx, "promote") },
  { name: "sm_gang_demote", run: (ctx) => changeRank(ctx, "demote") },
  { name: "sm_gang_transfer", run: cmdTransfer },
  { name: "sm_gang_members", run: cmdMembers },
  { name: "sm_gang_ranks", run: cmdRanks },
  { name: "sm_gang_rank_create", run: cmdRankCreate },
  { name: "sm_gang_rank_rename", run: cmdRankRename },
  { name: "sm_gang_rank_delete", run: cmdRankDelete },
  { name: "sm_gang_rank_perm", run: cmdRankPerm },
  { name: "sm_gang_doorpolicy", run: cmdDoorPolicy },
  { name: "sm_gang_perks", run: cmdPerks },
  { name: "sm_gang_purchase", run: cmdPurchase },
  { name: "sm_gang_motd", run: cmdMotd },
  { name: "sm_gang_disband", run: cmdDisband },
  { name: "sm_gang_balance", run: cmdBalance },
  { name: "sm_gang_deposit", run: cmdDeposit },
  { name: "sm_gang_help", run: cmdHelp },
];

/** Run a command by its full name (used by the menu router and tests; the runtime registers each
 *  command directly with the engine). */
export function runCommand(name: string, ctx: CmdCtx): void {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new Error(`unknown command: ${name}`);
  cmd.run(ctx);
}
