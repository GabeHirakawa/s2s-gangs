import { describe, it, expect } from "vitest";
import { harness, S, type Harness } from "../support/harness";
import {
  mainMenuModel, membersMenuModel, memberActionsModel, perksMenuModel, ranksMenuModel, doorPolicyModel,
} from "../../src/menus/menu-model";
import { route, type RouterCtx } from "../../src/menus/menu-router";
import { CAPACITY_STAT, CHAT_STAT, MOTD_STAT } from "../../src/store/stats";

async function world(): Promise<Harness> {
  const h = await harness();
  await h.connect(S.owner, "O");
  await h.connect(S.bob, "Bob");
  const g = h.gangs.svc.createGang("Wolves", S.owner)!;
  h.gangs.svc.addMember(g.gangId, S.bob, 100);
  return h;
}

function rctx(h: Harness, viewer: string) {
  const calls: Array<[string, string[]]> = [];
  const ran: string[] = [];
  const ctx: RouterCtx = {
    gangs: h.gangs, viewerSteam: viewer,
    run: (c, args) => { calls.push([c, args]); },
    runAsPlayer: (c) => { ran.push(c); },
  };
  return { ctx, calls, ran };
}

describe("menu models", () => {
  it("main menu items follow the viewer's permissions; MOTD shows in the title", async () => {
    const h = await world();
    expect(mainMenuModel(h.gangs, S.owner).items.map((i) => i.info))
      .toEqual(["nav:members", "nav:invites", "nav:ranks", "nav:door", "nav:perks"]);
    expect(mainMenuModel(h.gangs, S.bob).items.map((i) => i.info)).toEqual(["nav:members", "nav:perks"]);
    expect(mainMenuModel(h.gangs, S.dave)).toEqual({ title: "Gang", items: [{ info: "nav:members", label: "Members" }] });
    h.gangs.svc.setGangStat(1, MOTD_STAT, "Raid at 9");
    expect(mainMenuModel(h.gangs, S.owner).title).toBe("Gang: Wolves — Raid at 9");
  });

  it("members, member actions, ranks and door models", async () => {
    const h = await world();
    expect(membersMenuModel(h.gangs, 1).items).toEqual([
      { info: `member:${S.owner}`, label: "O (Owner)" },
      { info: `member:${S.bob}`, label: "Bob (Member)" },
    ]);
    expect(memberActionsModel(h.gangs, S.owner, S.bob)?.items.map((i) => i.label)).toEqual(["Promote", "Demote", "Kick"]);
    expect(memberActionsModel(h.gangs, S.bob, S.owner)?.items).toEqual([]);
    expect(memberActionsModel(h.gangs, S.owner, S.dave)).toBeNull();
    expect(ranksMenuModel(h.gangs, 1).items).toHaveLength(5);
    expect(doorPolicyModel().items.map((i) => i.info)).toEqual(["door:open", "door:invite", "door:request"]);
  });

  it("perks menu shows prices, disables owned perks, and lists running custom perks", async () => {
    let running = true;
    const h = await harness({ running: () => running });
    await h.connect(S.owner, "O");
    h.gangs.svc.createGang("Wolves", S.owner);
    h.gangs.svc.setGangStat(1, CHAT_STAT, 1);
    h.gangs.perks.register("warden", { id: "icon", name: "Warden Icon", description: "", command: "sm_wardenicon" });
    const items = perksMenuModel(h.gangs, 1).items;
    expect(items.find((i) => i.info === `perk:${CAPACITY_STAT}`)?.label).toMatch(/^Capacity 0\/14: \d+cr$/);
    expect(items.find((i) => i.info === `perk:${CHAT_STAT}`)).toMatchObject({ disabled: true });
    expect(items.find((i) => i.info === "perk:icon")).toEqual({ info: "perk:icon", label: "Warden Icon" });
    running = false;
    expect(perksMenuModel(h.gangs, 1).items.map((i) => i.info)).not.toContain("perk:icon");
  });
});

describe("menu router", () => {
  it("routes a member action through run and returns to the members list", async () => {
    const h = await world();
    const r = rctx(h, S.owner);
    const next = route(`action:kick:${S.bob}`, r.ctx);
    expect(r.calls).toEqual([["sm_gang_kick", [S.bob]]]);
    expect(next?.title).toBe("Members");
  });

  it("routes door selection and returns to main; unknown info closes", async () => {
    const h = await world();
    const r = rctx(h, S.owner);
    expect(route("door:open", r.ctx)?.title).toContain("Gang");
    expect(r.calls).toEqual([["sm_gang_doorpolicy", ["open"]]]);
    expect(route("bogus", r.ctx)).toBeNull();
  });

  it("tapping a rank row keeps the Ranks list open", async () => {
    const h = await world();
    const r = rctx(h, S.owner);
    expect(route("rank:0", r.ctx)?.title).toBe("Ranks");
    expect(r.calls).toEqual([]);
  });

  it("perk:<levelled> purchases; perk:<custom> runs its command as the player and closes", async () => {
    const h = await world();
    h.gangs.perks.register("warden", { id: "icon", name: "Warden Icon", description: "", command: "sm_wardenicon" });
    const r = rctx(h, S.owner);
    expect(route(`perk:${CAPACITY_STAT}`, r.ctx)?.title).toBe("Perks");
    expect(r.calls).toEqual([["sm_gang_purchase", [CAPACITY_STAT]]]);
    expect(route("perk:icon", r.ctx)).toBeNull();
    expect(r.ran).toEqual(["sm_wardenicon"]);
  });

  it("nav entries close for a gangless viewer", async () => {
    const h = await world();
    await h.connect(S.dave, "D");
    const r = rctx(h, S.dave);
    expect(route("nav:members", r.ctx)).toBeNull();
    expect(route("nav:perks", r.ctx)).toBeNull();
  });
});
