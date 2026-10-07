import type { Gangs } from "../service/gangs";
import {
  type MenuModel, mainMenuModel, membersMenuModel, memberActionsModel, ranksMenuModel, doorPolicyModel, perksMenuModel,
} from "./menu-model";

export interface RouterCtx {
  gangs: Gangs;
  viewerSteam: string;
  /** Run one of Gangs' own commands as the viewer, replying into their chat. */
  run(command: string, args: string[]): void;
  /** Run an arbitrary console command as the viewer (custom perks from other plugins). */
  runAsPlayer(command: string): void;
}

function gangIdOf(rctx: RouterCtx): number | null {
  const p = rctx.gangs.svc.getPlayer(rctx.viewerSteam);
  return p && p.gangId !== null ? p.gangId : null;
}

/** Handle a selection; returns the next menu to show, or null to close. */
export function route(info: string, rctx: RouterCtx): MenuModel | null {
  const g = rctx.gangs;
  if (info === "nav:main") return mainMenuModel(g, rctx.viewerSteam);
  if (info === "nav:members") {
    const id = gangIdOf(rctx); return id === null ? null : membersMenuModel(g, id);
  }
  if (info === "nav:ranks") {
    const id = gangIdOf(rctx); return id === null ? null : ranksMenuModel(g, id);
  }
  if (info === "nav:door") return doorPolicyModel();
  if (info === "nav:invites") { rctx.run("sm_gang_invites", []); return null; }
  if (info === "nav:perks") {
    const id = gangIdOf(rctx); return id === null ? null : perksMenuModel(g, id);
  }

  if (info.startsWith("member:")) {
    // null when the target is no longer a fellow member: the menu closes silently.
    return memberActionsModel(g, rctx.viewerSteam, info.slice("member:".length));
  }
  if (info.startsWith("action:")) {
    const [, verb, steam] = info.split(":");
    if (verb && steam) {
      rctx.run(`sm_gang_${verb}`, [steam]);
      const id = gangIdOf(rctx);
      return id === null ? null : membersMenuModel(g, id);
    }
    return null;
  }
  if (info.startsWith("rank:")) {
    // Rank editing is command-only by design (sm_gang_rank_* commands); re-show the Ranks list.
    const id = gangIdOf(rctx); return id === null ? null : ranksMenuModel(g, id);
  }
  if (info.startsWith("door:")) {
    rctx.run("sm_gang_doorpolicy", [info.slice("door:".length)]);
    return mainMenuModel(g, rctx.viewerSteam);
  }
  if (info.startsWith("perk:")) {
    const perkId = info.slice("perk:".length);
    const perk = g.perks.get(perkId);
    if (perk && perk.command !== null) { rctx.runAsPlayer(perk.command); return null; }
    rctx.run("sm_gang_purchase", [perkId]);
    const id = gangIdOf(rctx); return id === null ? null : perksMenuModel(g, id);
  }
  return null; // unknown / close
}
