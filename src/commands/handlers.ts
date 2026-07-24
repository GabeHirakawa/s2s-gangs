import type { CmdCtx } from "./ctx";
export type { CmdCtx, OnlinePlayer } from "./ctx";
import type { StatDescriptor } from "../db/instance.repo";
import { Perm } from "../domain/perm";
import { DoorPolicy } from "../domain/types";

export const INVITATION_STAT: StatDescriptor = {
  id: "gang_invitation", scope: "gang", kind: "record",
  columns: {
    InvitedSteams: "VARCHAR(255)", InviterSteams: "VARCHAR(255)",
    RequestedSteams: "VARCHAR(255)", Dates: "VARCHAR(255)", MaxAmo: "INT",
  },
};
export const PENDING_STAT: StatDescriptor = {
  id: "pending_invitation", scope: "player", kind: "record", columns: { InvitingGangs: "VARCHAR(255)" },
};
export const DOOR_POLICY_STAT: StatDescriptor = {
  id: "gang_door_policy", scope: "gang", kind: "scalar", column: "INT",
};

async function requireGang(ctx: CmdCtx): Promise<{ steam: string; gangId: number; rank: number } | null> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return null; }
  const p = await ctx.api.players.get(ctx.steam, false);
  if (!p || p.gangId === null || p.gangRank === null) { ctx.reply(ctx.msg.notInGang()); return null; }
  return { steam: ctx.steam, gangId: p.gangId, rank: p.gangRank };
}

async function gate(ctx: CmdCtx, steam: string, perm: number, node: string): Promise<boolean> {
  if (await ctx.api.ranks.checkPermission(steam, perm)) return true;
  ctx.reply(ctx.msg.noPermission(node));
  return false;
}

async function cmdCreate(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const name = ctx.args.join(" ").trim();
  if (!name) { ctx.reply(ctx.msg.usage("!gang_create <name>")); return; }
  const existing = await ctx.api.players.get(ctx.steam, false);
  if (existing?.gangId != null) { ctx.reply(ctx.msg.alreadyInGang()); return; }
  await ctx.api.players.create(ctx.steam, ctx.online(ctx.steam)[0]?.name ?? null);
  const gang = await ctx.api.gangs.create(name, ctx.steam);
  ctx.reply(gang ? ctx.msg.created(gang.name, gang.gangId) : "Failed to create gang.");
}

async function cmdInvite(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.INVITE_OTHERS, "Invite Others"))) return;
  const query = ctx.args.join(" ").trim();
  const matches = ctx.online(query);
  if (matches.length !== 1) { ctx.reply(ctx.msg.playerNotFound(query)); return; }
  const target = matches[0];
  const targetPlayer = await ctx.api.players.get(target.steam, false);
  if (targetPlayer?.gangId != null) { ctx.reply(`${target.name} is already in a gang.`); return; }
  await ctx.api.invites.create(me.gangId, me.steam, target.steam, ctx.nowSec);
  const gang = await ctx.api.gangs.get(me.gangId);
  ctx.reply(ctx.msg.invited(target.name, gang?.name ?? String(me.gangId)));
}

async function cmdInvites(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const list = await ctx.api.invites.outgoing(me.gangId);
  ctx.reply(list.length ? `Outgoing invites: ${list.join(", ")}` : "Your gang has not invited anyone.");
}

async function cmdPending(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const gangs = await ctx.api.invites.pending(ctx.steam);
  if (!gangs.length) { ctx.reply("You have no pending invites."); return; }
  const names: string[] = [];
  for (const id of gangs) names.push((await ctx.api.gangs.get(id))?.name ?? `#${id}`);
  ctx.reply(`Invited by: ${names.join(", ")}. Use !gang_join <name> to accept.`);
}

async function resolveGangByName(ctx: CmdCtx, query: string): Promise<number | null> {
  const q = query.trim().toLowerCase();
  const all = await ctx.api.gangs.getAll();
  const byName = all.filter((g) => g.name.toLowerCase() === q);
  if (byName.length === 1) return byName[0].gangId;
  const partial = all.filter((g) => g.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0].gangId : null;
}

async function cmdJoin(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const player = await ctx.api.players.get(ctx.steam, false);
  if (player?.gangId != null) { ctx.reply(ctx.msg.alreadyInGang()); return; }
  const gangId = await resolveGangByName(ctx, ctx.args.join(" "));
  if (gangId === null) { ctx.reply("Could not find that gang."); return; }

  const policy = (await ctx.api.stats.getForGang<number>(gangId, "gang_door_policy")) ?? DoorPolicy.REQUEST_ONLY;
  const invited = (await ctx.api.invites.outgoing(gangId)).includes(ctx.steam);
  // v0.1: OPEN lets anyone in; every other policy requires an invite (request-to-join is deferred).
  if (policy !== DoorPolicy.OPEN && !invited) { ctx.reply("You need an invite to join this gang."); return; }

  await ctx.api.players.create(ctx.steam, ctx.online(ctx.steam)[0]?.name ?? null);
  const joinRank = await ctx.api.ranks.getJoinRank(gangId);
  if (!joinRank) { ctx.reply("Failed to join."); return; }
  await ctx.api.members.add(gangId, ctx.steam, joinRank.rank);
  if (invited) await ctx.api.invites.revoke(gangId, ctx.steam);
  const gang = await ctx.api.gangs.get(gangId);
  ctx.reply(ctx.msg.joined(gang?.name ?? String(gangId)));
}

async function cmdLeave(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (me.rank === 0) { ctx.reply("Owners must transfer or disband, not leave."); return; }
  const p = await ctx.api.players.get(me.steam, false);
  await ctx.api.members.remove(me.steam, "leave");
  ctx.reply(ctx.msg.left(p?.name ?? me.steam));
}

async function cmdKick(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.KICK_OTHERS, "Kick Others"))) return;
  const target = await ctx.api.players.findInGang(me.gangId, ctx.args.join(" "));
  if (!target || target.gangRank === null) { ctx.reply(ctx.msg.playerNotFound(ctx.args.join(" "))); return; }
  if (target.gangRank <= me.rank) { ctx.reply("You cannot kick someone of equal or higher rank."); return; }
  await ctx.api.members.remove(target.steam, "kick");
  ctx.reply(ctx.msg.kicked(target.name ?? target.steam));
}

async function changeRank(ctx: CmdCtx, dir: "promote" | "demote"): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const perm = dir === "promote" ? Perm.PROMOTE_OTHERS : Perm.DEMOTE_OTHERS;
  if (!(await gate(ctx, me.steam, perm, dir === "promote" ? "Promote Others" : "Demote Others"))) return;
  const target = await ctx.api.players.findInGang(me.gangId, ctx.args.join(" "));
  if (!target || target.gangRank === null) { ctx.reply(ctx.msg.playerNotFound(ctx.args.join(" "))); return; }
  if (target.gangRank <= me.rank) { ctx.reply("You cannot change the rank of someone equal or above you."); return; }
  const ranks = await ctx.api.ranks.getAll(me.gangId);
  const sorted = ranks.map((r) => r.rank).sort((a, b) => a - b);
  const idx = sorted.indexOf(target.gangRank);
  const nextRank = dir === "promote" ? sorted[idx - 1] : sorted[idx + 1];
  if (nextRank === undefined) { ctx.reply("No rank to move to."); return; }
  if (dir === "promote" && nextRank <= me.rank) { ctx.reply("You cannot promote above yourself."); return; }
  await ctx.api.members.setRank(target.steam, nextRank);
  const rankObj = ranks.find((r) => r.rank === nextRank)!;
  ctx.reply(dir === "promote"
    ? ctx.msg.promoted(target.name ?? target.steam, rankObj.name)
    : ctx.msg.demoted(target.name ?? target.steam, rankObj.name));
}

async function cmdTransfer(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  const target = await ctx.api.players.findInGang(me.gangId, ctx.args.join(" "));
  if (!target || target.gangRank === null || target.steam === me.steam) {
    ctx.reply(ctx.msg.playerNotFound(ctx.args.join(" "))); return;
  }
  const joinRank = await ctx.api.ranks.getJoinRank(me.gangId);
  await ctx.api.members.setRank(target.steam, 0);
  await ctx.api.members.setRank(me.steam, joinRank?.rank ?? me.rank);
  ctx.reply(`Transferred ownership to ${target.name ?? target.steam}.`);
}

async function cmdMembers(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  const members = await ctx.api.players.getMembers(me.gangId);
  const ranks = await ctx.api.ranks.getAll(me.gangId);
  const rankName = (n: number | null): string => ranks.find((r) => r.rank === n)?.name ?? "?";
  ctx.reply("Members:");
  for (const m of members) ctx.reply(ctx.msg.memberLine(m.name ?? m.steam, rankName(m.gangRank)));
}

async function cmdDoorPolicy(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (!(await gate(ctx, me.steam, Perm.MANAGE_RANKS, "Manage Ranks"))) return;
  const map: Record<string, DoorPolicy> = {
    open: DoorPolicy.OPEN, invite: DoorPolicy.INVITE_ONLY, request: DoorPolicy.REQUEST_ONLY,
  };
  const choice = map[(ctx.args[0] ?? "").toLowerCase()];
  if (choice === undefined) { ctx.reply(ctx.msg.usage("!gang_doorpolicy <open|invite|request>")); return; }
  await ctx.api.stats.setForGang(me.gangId, "gang_door_policy", choice);
  ctx.reply(`Door policy set to ${ctx.args[0].toLowerCase()}.`);
}

async function cmdDisband(ctx: CmdCtx): Promise<void> {
  const me = await requireGang(ctx); if (!me) return;
  if (me.rank !== 0) { ctx.reply(ctx.msg.noPermission("Owner")); return; }
  if ((ctx.args[0] ?? "").toLowerCase() !== "confirm") { ctx.reply(ctx.msg.disbandWarning()); return; }
  const gang = await ctx.api.gangs.get(me.gangId);
  await ctx.api.gangs.delete(me.gangId);
  ctx.reply(ctx.msg.disbanded(gang?.name ?? String(me.gangId)));
}

async function cmdInfo(ctx: CmdCtx): Promise<void> {
  if (ctx.steam === null) { ctx.reply("Only players can use this."); return; }
  const membership = await ctx.api.players.getMembership(ctx.steam);
  if (!membership) { ctx.reply(ctx.msg.notInGang()); return; }
  const count = (await ctx.api.players.getMembers(membership.gang.gangId)).length;
  ctx.reply(`${membership.gang.name} — your rank: ${membership.rank.name} — members: ${count}`);
}

function cmdHelp(ctx: CmdCtx): Promise<void> {
  // Derived from COMMANDS: "!gang_create, !gang_invite, …" (the bare !gang omitted).
  const names = COMMANDS.map((c) => "!" + c.name.slice("sm_".length))
    .filter((n) => n !== "!gang").join(", ");
  ctx.reply(ctx.msg.usage(names));
  return Promise.resolve();
}

/** One registered command. `name` is the engine command (e.g. "sm_gang_create"); chat "!gang_create"
 *  resolves to it. Each is registered individually — there is no central subcommand dispatcher. */
export interface GangCommand {
  name: string;
  run: (ctx: CmdCtx) => Promise<void>;
}

export const COMMANDS: GangCommand[] = [
  { name: "sm_gang", run: cmdInfo },
  { name: "sm_gang_create", run: cmdCreate },
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
  { name: "sm_gang_doorpolicy", run: cmdDoorPolicy },
  { name: "sm_gang_disband", run: cmdDisband },
  { name: "sm_gang_help", run: cmdHelp },
];

/** Test/utility helper: run a registered command by its full name. The runtime does NOT route through
 *  this — each command is registered directly with the engine (see registerGangCommands). */
export function runCommand(name: string, ctx: CmdCtx): Promise<void> {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new Error(`unknown command: ${name}`);
  return cmd.run(ctx);
}
