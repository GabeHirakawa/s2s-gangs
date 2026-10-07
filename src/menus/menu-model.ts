import type { Gangs } from "../service/gangs";
import { Perm, hasPerm } from "../domain/perm";

export interface MenuItem { info: string; label: string; disabled?: boolean; }
export interface MenuModel { title: string; items: MenuItem[]; }

function viewer(g: Gangs, steam: string): { gangId: number; rank: number; perms: number } | null {
  const p = g.svc.getPlayer(steam);
  if (!p || p.gangId === null || p.gangRank === null) return null;
  const rank = g.svc.getRank(p.gangId, p.gangRank);
  return rank ? { gangId: p.gangId, rank: p.gangRank, perms: rank.permissions } : null;
}

export function mainMenuModel(g: Gangs, viewerSteam: string): MenuModel {
  const v = viewer(g, viewerSteam);
  const gang = v ? g.svc.getGang(v.gangId) : null;
  const items: MenuItem[] = [{ info: "nav:members", label: "Members" }];
  if (v && hasPerm(v.perms, Perm.INVITE_OTHERS)) items.push({ info: "nav:invites", label: "Invites" });
  if (v && hasPerm(v.perms, Perm.MANAGE_RANKS)) {
    items.push({ info: "nav:ranks", label: "Ranks" });
    items.push({ info: "nav:door", label: "Door Policy" });
  }
  if (v && hasPerm(v.perms, Perm.PURCHASE_PERKS)) items.push({ info: "nav:perks", label: "Perks" });
  const motd = v ? g.perks.motd(v.gangId) : null;
  const title = gang ? `Gang: ${gang.name}${motd ? ` — ${motd}` : ""}` : "Gang";
  return { title, items };
}

export function membersMenuModel(g: Gangs, gangId: number): MenuModel {
  const ranks = g.svc.ranksOf(gangId);
  const rankName = (n: number | null): string => ranks.find((r) => r.rank === n)?.name ?? "?";
  return {
    title: "Members",
    items: g.svc.membersOf(gangId).map((m) => ({ info: `member:${m.steam}`, label: `${m.name ?? m.steam} (${rankName(m.gangRank)})` })),
  };
}

export function memberActionsModel(g: Gangs, viewerSteam: string, targetSteam: string): MenuModel | null {
  const v = viewer(g, viewerSteam);
  const target = g.svc.getPlayer(targetSteam);
  if (!v || !target || target.gangId !== v.gangId || target.gangRank === null) return null;
  const items: MenuItem[] = [];
  const canAct = targetSteam !== viewerSteam && target.gangRank > v.rank;
  if (canAct && hasPerm(v.perms, Perm.PROMOTE_OTHERS)) items.push({ info: `action:promote:${targetSteam}`, label: "Promote" });
  if (canAct && hasPerm(v.perms, Perm.DEMOTE_OTHERS)) items.push({ info: `action:demote:${targetSteam}`, label: "Demote" });
  if (canAct && hasPerm(v.perms, Perm.KICK_OTHERS)) items.push({ info: `action:kick:${targetSteam}`, label: "Kick" });
  return { title: target.name ?? targetSteam, items };
}

export function ranksMenuModel(g: Gangs, gangId: number): MenuModel {
  return { title: "Ranks", items: g.svc.ranksOf(gangId).map((r) => ({ info: `rank:${r.rank}`, label: `[${r.rank}] ${r.name}` })) };
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

/** Native + running external perks. Levelled perks show their next price; custom perks run their command. */
export function perksMenuModel(g: Gangs, gangId: number): MenuModel {
  const items: MenuItem[] = [];
  for (const p of g.perks.all()) {
    if (p.command !== null) { items.push({ info: `perk:${p.id}`, label: p.name }); continue; }
    const cost = g.perks.nextCost(gangId, p.id);
    const max = p.levelled?.maxLevel ?? 0;
    const lvl = max > 1 ? ` ${g.perks.level(gangId, p.id)}/${max}` : "";
    items.push({ info: `perk:${p.id}`, label: `${p.name}${lvl}: ${cost === null ? "owned/max" : `${cost}cr`}`, disabled: cost === null });
  }
  return { title: "Perks", items };
}
