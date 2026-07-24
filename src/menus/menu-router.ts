import type { GangsApi } from "../../api";
import {
  type MenuModel, mainMenuModel, membersMenuModel, memberActionsModel, ranksMenuModel, doorPolicyModel, perksMenuModel,
} from "./menu-model";

export interface RouterCtx {
  api: GangsApi;
  viewerSteam: string;
  run(command: string, args: string[]): Promise<void>;
}

async function gangIdOf(rctx: RouterCtx): Promise<number | null> {
  const p = await rctx.api.players.get(rctx.viewerSteam, false);
  return p && p.gangId !== null ? p.gangId : null;
}

export async function route(info: string, rctx: RouterCtx): Promise<MenuModel | null> {
  if (info === "nav:main") return mainMenuModel(rctx.api, rctx.viewerSteam);
  if (info === "nav:members") {
    const g = await gangIdOf(rctx); return g === null ? null : membersMenuModel(rctx.api, g);
  }
  if (info === "nav:ranks") {
    const g = await gangIdOf(rctx); return g === null ? null : ranksMenuModel(rctx.api, g);
  }
  if (info === "nav:door") return doorPolicyModel();
  if (info === "nav:invites") { await rctx.run("sm_gang_invites", []); return null; }

  if (info.startsWith("member:")) {
    // memberActionsModel returns null when the target is no longer a fellow
    // member; v0.1 closes the menu silently in that case (RouterCtx exposes no
    // reply channel — see plan Task 5 error-handling note).
    return memberActionsModel(rctx.api, rctx.viewerSteam, info.slice("member:".length));
  }
  if (info.startsWith("action:")) {
    const [, verb, steam] = info.split(":");
    if (verb && steam) {
      await rctx.run(`sm_gang_${verb}`, [steam]);
      const g = await gangIdOf(rctx);
      return g === null ? null : membersMenuModel(rctx.api, g);
    }
    return null;
  }
  if (info.startsWith("rank:")) {
    // Rank editing is command-only by design (sm_gang_rank_* commands). A tap on
    // a rank row re-shows the Ranks list rather than closing the whole menu.
    const g = await gangIdOf(rctx); return g === null ? null : ranksMenuModel(rctx.api, g);
  }
  if (info.startsWith("door:")) {
    await rctx.run("sm_gang_doorpolicy", [info.slice("door:".length)]);
    return mainMenuModel(rctx.api, rctx.viewerSteam);
  }
  if (info === "nav:perks") {
    const g = await gangIdOf(rctx); return g === null ? null : perksMenuModel(rctx.api, g);
  }
  if (info.startsWith("perk:")) {
    await rctx.run("sm_gang_purchase", [info.slice("perk:".length)]);
    const g = await gangIdOf(rctx); return g === null ? null : perksMenuModel(rctx.api, g);
  }
  return null; // unknown / close
}
