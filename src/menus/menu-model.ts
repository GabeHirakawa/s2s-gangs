import type { GangsApi } from "../../api";
import { Perm, hasPerm } from "../domain/perm";

export interface MenuItem { info: string; label: string; disabled?: boolean; }
export interface MenuModel { title: string; items: MenuItem[]; }

async function viewerPerms(api: GangsApi, steam: string): Promise<{ gangId: number; rank: number; perms: number } | null> {
  const p = await api.players.get(steam, false);
  if (!p || p.gangId === null || p.gangRank === null) return null;
  const rank = await api.ranks.get(p.gangId, p.gangRank);
  return rank ? { gangId: p.gangId, rank: p.gangRank, perms: rank.permissions } : null;
}

export async function mainMenuModel(api: GangsApi, viewerSteam: string): Promise<MenuModel> {
  const v = await viewerPerms(api, viewerSteam);
  const gang = v ? await api.gangs.get(v.gangId) : null;
  const items: MenuItem[] = [{ info: "nav:members", label: "Members" }];
  if (v && hasPerm(v.perms, Perm.INVITE_OTHERS)) items.push({ info: "nav:invites", label: "Invites" });
  if (v && hasPerm(v.perms, Perm.MANAGE_RANKS)) {
    items.push({ info: "nav:ranks", label: "Ranks" });
    items.push({ info: "nav:door", label: "Door Policy" });
  }
  return { title: gang ? `Gang: ${gang.name}` : "Gang", items };
}

export async function membersMenuModel(api: GangsApi, gangId: number): Promise<MenuModel> {
  const members = await api.players.getMembers(gangId);
  const ranks = await api.ranks.getAll(gangId);
  const rankName = (n: number | null): string => ranks.find((r) => r.rank === n)?.name ?? "?";
  return {
    title: "Members",
    items: members.map((m) => ({ info: `member:${m.steam}`, label: `${m.name ?? m.steam} (${rankName(m.gangRank)})` })),
  };
}

export async function memberActionsModel(api: GangsApi, viewerSteam: string, targetSteam: string): Promise<MenuModel | null> {
  const v = await viewerPerms(api, viewerSteam);
  const target = await api.players.get(targetSteam, false);
  if (!v || !target || target.gangId !== v.gangId || target.gangRank === null) return null;
  const items: MenuItem[] = [];
  const canAct = targetSteam !== viewerSteam && target.gangRank > v.rank;
  if (canAct && hasPerm(v.perms, Perm.PROMOTE_OTHERS)) items.push({ info: `action:promote:${targetSteam}`, label: "Promote" });
  if (canAct && hasPerm(v.perms, Perm.DEMOTE_OTHERS)) items.push({ info: `action:demote:${targetSteam}`, label: "Demote" });
  if (canAct && hasPerm(v.perms, Perm.KICK_OTHERS)) items.push({ info: `action:kick:${targetSteam}`, label: "Kick" });
  return { title: target.name ?? targetSteam, items };
}

export async function ranksMenuModel(api: GangsApi, gangId: number): Promise<MenuModel> {
  const ranks = await api.ranks.getAll(gangId);
  return { title: "Ranks", items: ranks.map((r) => ({ info: `rank:${r.rank}`, label: `[${r.rank}] ${r.name}` })) };
}

export function doorPolicyModel(): MenuModel {
  return {
    title: "Door Policy",
    items: [
      { info: "door:open", label: "Open (anyone joins)" },
      { info: "door:invite", label: "Invite Only" },
      { info: "door:request", label: "Request Only" },
    ],
  };
}
