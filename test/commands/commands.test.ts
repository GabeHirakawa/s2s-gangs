import { describe, it, expect } from "vitest";
import { harness, S, type Harness } from "../support/harness";
import { runCommand, COMMANDS } from "../../src/commands/handlers";
import { runCredits } from "../../src/commands/credits";
import { Perm } from "../../src/domain/perm";
import { CAPACITY_STAT, CHAT_STAT, MOTD_STAT } from "../../src/store/stats";

/** Owner "O" with gang Wolves (capacity 15), plus Bob online and gangless. */
async function world(): Promise<Harness> {
  const h = await harness();
  await h.connect(S.owner, "O");
  await h.connect(S.bob, "Bob");
  runCommand("sm_gang_create", h.ctx(S.owner, ["Wolves"]));
  h.gangs.svc.setGangStat(1, CAPACITY_STAT, 15);
  h.replies.length = 0;
  return h;
}

function bobJoins(h: Harness): void {
  runCommand("sm_gang_invite", h.ctx(S.owner, ["Bob"]));
  runCommand("sm_gang_join", h.ctx(S.bob, ["Wolves"]));
}

const said = (h: Harness): string => h.replies.join("\n");

describe("core gang commands", () => {
  it("registers every sm_gang_* name", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining([
      "sm_gang", "sm_gang_create", "sm_gang_invite", "sm_gang_invites", "sm_gang_pending", "sm_gang_join",
      "sm_gang_leave", "sm_gang_kick", "sm_gang_promote", "sm_gang_demote", "sm_gang_transfer",
      "sm_gang_members", "sm_gang_ranks", "sm_gang_rank_create", "sm_gang_rank_rename", "sm_gang_rank_delete",
      "sm_gang_rank_perm", "sm_gang_doorpolicy", "sm_gang_perks", "sm_gang_purchase", "sm_gang_motd",
      "sm_gang_disband", "sm_gang_balance", "sm_gang_deposit", "sm_gang_help", "sm_gang_rename",
    ]));
  });

  it("create makes a gang and reports success; refuses duplicates", async () => {
    const h = await harness();
    await h.connect(S.owner, "O");
    await h.connect(S.bob, "B");
    runCommand("sm_gang_create", h.ctx(S.owner, ["Wolves"]));
    expect(said(h)).toContain("Wolves");
    expect(h.gangs.svc.gangOf(S.owner)?.name).toBe("Wolves");
    runCommand("sm_gang_create", h.ctx(S.bob, ["wolves"]));
    expect(said(h)).toContain("already exists");
  });

  it("console callers and not-yet-loaded players get a reply, not an error", async () => {
    const h = await harness();
    runCommand("sm_gang_create", h.ctx(null, ["X"]));
    runCommand("sm_gang_create", h.ctx(S.dave, ["X"]));
    expect(h.replies).toEqual(["Only players can use this.", expect.stringContaining("loading")]);
  });

  it("invite then join moves the invitee into the gang and clears the invite", async () => {
    const h = await world();
    runCommand("sm_gang_invite", h.ctx(S.owner, ["Bob"]));
    runCommand("sm_gang_pending", h.ctx(S.bob, []));
    expect(said(h)).toContain("Invited by: Wolves");
    runCommand("sm_gang_join", h.ctx(S.bob, ["Wolves"]));
    expect(h.gangs.svc.getPlayer(S.bob)).toMatchObject({ gangId: 1, gangRank: 100 });
    expect(h.gangs.svc.outgoingInvites(1)).toEqual([]);
  });

  it("join needs an invite unless the door policy is open", async () => {
    const h = await world();
    runCommand("sm_gang_join", h.ctx(S.bob, ["Wolves"]));
    expect(said(h)).toContain("need an invite");
    runCommand("sm_gang_doorpolicy", h.ctx(S.owner, ["open"]));
    runCommand("sm_gang_join", h.ctx(S.bob, ["wol"]));
    expect(h.gangs.svc.getPlayer(S.bob)?.gangId).toBe(1);
  });

  it("join is refused when the gang is at capacity", async () => {
    const h = await world();
    h.gangs.svc.setGangStat(1, CAPACITY_STAT, null); // default capacity 1 — the owner fills it
    runCommand("sm_gang_invite", h.ctx(S.owner, ["Bob"]));
    h.replies.length = 0;
    runCommand("sm_gang_join", h.ctx(S.bob, ["Wolves"]));
    expect(said(h).toLowerCase()).toContain("full");
    expect(h.gangs.svc.getPlayer(S.bob)?.gangId).toBeNull();
  });

  it("kick requires KICK_OTHERS and removes a lower member", async () => {
    const h = await world();
    bobJoins(h);
    runCommand("sm_gang_kick", h.ctx(S.bob, ["O"]));
    expect(said(h)).toContain("Kick Others");
    runCommand("sm_gang_kick", h.ctx(S.owner, ["Bob"]));
    expect(h.gangs.svc.getPlayer(S.bob)?.gangId).toBeNull();
    expect(h.eventsNamed("OnMemberLeft")).toEqual([{ gangId: 1, steamId: S.bob, reason: "kick" }]);
  });

  it("promote/demote walk the rank ladder; a lower rank cannot demote the owner", async () => {
    const h = await world();
    bobJoins(h);
    runCommand("sm_gang_promote", h.ctx(S.owner, ["bob"]));  // 100 -> 50
    runCommand("sm_gang_promote", h.ctx(S.owner, ["bob"]));  // 50 -> 30 Manager (has DEMOTE_OTHERS)
    expect(h.gangs.svc.getPlayer(S.bob)?.gangRank).toBe(30);
    runCommand("sm_gang_demote", h.ctx(S.bob, ["O"]));
    expect(h.gangs.svc.getPlayer(S.owner)?.gangRank).toBe(0);
    runCommand("sm_gang_demote", h.ctx(S.owner, ["bob"]));
    expect(h.gangs.svc.getPlayer(S.bob)?.gangRank).toBe(50);
  });

  it("leave: owners cannot leave; members can", async () => {
    const h = await world();
    bobJoins(h);
    runCommand("sm_gang_leave", h.ctx(S.owner, []));
    expect(said(h)).toContain("Owners must transfer");
    runCommand("sm_gang_leave", h.ctx(S.bob, []));
    expect(h.gangs.svc.getPlayer(S.bob)?.gangId).toBeNull();
  });

  it("transfer hands rank 0 to the target and demotes the old owner to the join rank", async () => {
    const h = await world();
    bobJoins(h);
    runCommand("sm_gang_transfer", h.ctx(S.owner, ["Bob"]));
    expect(h.gangs.svc.getPlayer(S.bob)?.gangRank).toBe(0);
    expect(h.gangs.svc.getPlayer(S.owner)?.gangRank).toBe(100);
  });

  it("members / info / ranks list from the cache", async () => {
    const h = await world();
    bobJoins(h);
    h.replies.length = 0;
    runCommand("sm_gang_members", h.ctx(S.owner, []));
    runCommand("sm_gang", h.ctx(S.bob, []));
    runCommand("sm_gang_ranks", h.ctx(S.bob, []));
    expect(h.replies).toEqual(expect.arrayContaining([
      "Members:", "  O — Owner", "  Bob — Member", "Wolves — your rank: Member — members: 2", "  [0] Owner — Owner",
    ]));
  });

  it("disband needs confirm and the owner", async () => {
    const h = await world();
    bobJoins(h);
    runCommand("sm_gang_disband", h.ctx(S.bob, ["confirm"]));
    runCommand("sm_gang_disband", h.ctx(S.owner, []));
    expect(h.gangs.svc.getGang(1)).not.toBeNull();
    runCommand("sm_gang_disband", h.ctx(S.owner, ["confirm"]));
    expect(h.gangs.svc.getGang(1)).toBeNull();
    expect(said(h)).toContain("disbanded");
  });

  it("rename is owner-only and emits OnGangRenamed", async () => {
    const h = await world();
    bobJoins(h);
    runCommand("sm_gang_rename", h.ctx(S.bob, ["Lions"]));
    runCommand("sm_gang_rename", h.ctx(S.owner, ["Lions"]));
    expect(h.gangs.svc.getGang(1)?.name).toBe("Lions");
    expect(h.eventsNamed("OnGangRenamed")).toEqual([{ gangId: 1, name: "Lions" }]);
  });

  it("help lists the commands without the bare !gang", async () => {
    const h = await world();
    runCommand("sm_gang_help", h.ctx(S.owner, []));
    expect(said(h)).toContain("!gang_create");
    expect(said(h)).toContain("!gang_menu");
    expect(said(h)).not.toMatch(/!gang(,|$)/);
  });
});

describe("rank administration commands", () => {
  it("rank_create adds a rank strictly below the caller", async () => {
    const h = await world();
    runCommand("sm_gang_rank_create", h.ctx(S.owner, ["70", "Scout"]));
    expect(h.gangs.svc.getRank(1, 70)?.name).toBe("Scout");
    runCommand("sm_gang_rank_create", h.ctx(S.owner, ["0", "Nope"]));
    expect(said(h)).toContain("below your own");
  });

  it("rank_rename / rank_delete / rank_perm", async () => {
    const h = await world();
    runCommand("sm_gang_rank_rename", h.ctx(S.owner, ["100", "Grunt"]));
    expect(h.gangs.svc.getRank(1, 100)?.name).toBe("Grunt");
    runCommand("sm_gang_rank_delete", h.ctx(S.owner, ["50"]));
    expect(h.gangs.svc.getRank(1, 50)).toBeNull();
    runCommand("sm_gang_rank_perm", h.ctx(S.owner, ["100", "kick_others", "on"]));
    expect(h.gangs.svc.getRank(1, 100)!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
    runCommand("sm_gang_rank_perm", h.ctx(S.owner, ["0", "kick_others", "off"]));
    expect(h.gangs.svc.getRank(1, 0)!.permissions & Perm.KICK_OTHERS).toBe(Perm.KICK_OTHERS);
  });

  it("a Manager cannot grant CREATE_RANKS nor create ranks", async () => {
    const h = await world();
    bobJoins(h);
    h.gangs.svc.setMemberRank(S.bob, 30);
    h.replies.length = 0;
    runCommand("sm_gang_rank_perm", h.ctx(S.bob, ["100", "create_ranks", "on"]));
    expect(h.gangs.svc.getRank(1, 100)!.permissions & Perm.CREATE_RANKS).toBe(0);
    expect(said(h)).toContain("cannot grant a permission you do not have");
    runCommand("sm_gang_rank_create", h.ctx(S.bob, ["70", "Scout"]));
    expect(h.gangs.svc.getRank(1, 70)).toBeNull();
  });
});

describe("economy commands", () => {
  it("deposit moves wallet credits into the bank", async () => {
    const h = await world();
    h.gangs.eco.grantPlayer(S.owner, 100, "seed");
    runCommand("sm_gang_deposit", h.ctx(S.owner, ["40"]));
    expect(h.gangs.eco.getGangBalance(1)).toBe(40);
    expect(h.gangs.eco.wallet(S.owner)).toBe(60);
    runCommand("sm_gang_deposit", h.ctx(S.owner, ["all"]));
    expect(h.gangs.eco.getGangBalance(1)).toBe(100);
  });

  it("deposit refuses bad amounts, too-large amounts and ranks without BANK_DEPOSIT", async () => {
    const h = await world();
    h.gangs.eco.grantPlayer(S.owner, 10, "seed");
    runCommand("sm_gang_deposit", h.ctx(S.owner, ["40abc"]));
    expect(said(h).toLowerCase()).toContain("usage");
    runCommand("sm_gang_deposit", h.ctx(S.owner, ["40"]));
    expect(said(h)).toContain("30 credits short");
    bobJoins(h);
    h.gangs.svc.createRank(1, "Mute", 200, 0);
    h.gangs.svc.setMemberRank(S.bob, 200);
    h.gangs.eco.grantPlayer(S.bob, 100, "seed");
    runCommand("sm_gang_deposit", h.ctx(S.bob, ["40"]));
    expect(said(h)).toContain("Deposit Money");
    expect(h.gangs.eco.getGangBalance(1)).toBe(0);
  });

  it("balance reports wallet and bank", async () => {
    const h = await world();
    h.gangs.eco.grantPlayer(S.owner, 30, "seed");
    h.gangs.eco.grantGang(1, 5, "seed");
    runCommand("sm_gang_balance", h.ctx(S.owner, []));
    expect(h.replies).toEqual([expect.stringContaining("30 credits"), expect.stringContaining("Wolves's bank has 5")]);
  });

  it("sm_credits grants to a unique online, loaded player", async () => {
    const h = await world();
    const run = (args: string[]) => runCredits({ args, reply: (m) => h.replies.push(m), gangs: h.gangs, msg: h.ctx(null, []).msg, online: h.ctx(null, []).online });
    run(["Bob"]);
    run(["Nobody", "5"]);
    run(["Bob", "5x"]);
    run(["Bob", "+25", "event", "win"]);
    expect(h.replies).toEqual([
      "Usage: sm_credits <player> <amount> [reason]",
      'Could not find a unique player for "Nobody".',
      "Amount must be an integer.",
      "Bob now has 25 credits.",
    ]);
    expect(h.eventsNamed("OnBalanceChanged")).toEqual([{ kind: "player", steamId: S.bob, balance: 25, delta: 25, reason: "event win" }]);
  });
});

describe("perk commands", () => {
  it("perks lists natives (and running custom perks)", async () => {
    const h = await world();
    h.gangs.perks.register("warden", { id: "icon", name: "Icon", description: "", command: "sm_wardenicon" });
    runCommand("sm_gang_perks", h.ctx(S.owner, []));
    expect(said(h)).toContain(CAPACITY_STAT);
    expect(said(h)).toContain(CHAT_STAT);
    expect(said(h)).toContain("!wardenicon");
  });

  it("purchase maps every reason to a reply", async () => {
    const h = await world();
    runCommand("sm_gang_purchase", h.ctx(S.owner, []));
    runCommand("sm_gang_purchase", h.ctx(S.owner, ["nope"]));
    runCommand("sm_gang_purchase", h.ctx(S.owner, [CHAT_STAT]));
    runCommand("sm_gang_purchase", h.ctx(S.bob, [CHAT_STAT]));
    h.gangs.eco.grantPlayer(S.owner, 5000, "seed");
    runCommand("sm_gang_purchase", h.ctx(S.owner, [CHAT_STAT]));
    runCommand("sm_gang_purchase", h.ctx(S.owner, [CHAT_STAT]));
    expect(h.replies).toEqual([
      expect.stringContaining("Usage"),
      expect.stringContaining('No such perk "nope"'),
      expect.stringContaining("cannot afford that (5000 credits)"),
      expect.stringContaining("not in a gang"),
      `Purchased ${CHAT_STAT}. Balance: 0.`,
      expect.stringContaining("already owned or at max level"),
    ]);
  });

  it("motd requires the perk and MANAGE_PERKS", async () => {
    const h = await world();
    runCommand("sm_gang_motd", h.ctx(S.owner, ["Hi"]));
    expect(said(h)).toContain("purchase the MOTD perk first");
    h.gangs.eco.grantPlayer(S.owner, 7500, "seed");
    runCommand("sm_gang_purchase", h.ctx(S.owner, [MOTD_STAT]));
    runCommand("sm_gang_motd", h.ctx(S.owner, ["Raid", "tonight"]));
    expect(h.gangs.perks.motd(1)).toBe("Raid tonight");
    bobJoins(h);
    runCommand("sm_gang_motd", h.ctx(S.bob, ["mine"]));
    expect(said(h)).toContain("Manage Perks");
  });
});
