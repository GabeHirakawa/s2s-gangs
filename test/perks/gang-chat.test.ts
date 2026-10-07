import { describe, it, expect } from "vitest";
import { harness, S } from "../support/harness";
import { parseGangChat, resolveGangChat } from "../../src/perks/gang-chat";
import { makeMessages } from "../../src/messages";
import { CHAT_STAT } from "../../src/store/stats";
import { Perm } from "../../src/domain/perm";

describe("parseGangChat", () => {
  it("strips the leading dot; rejects non-dot and empty", () => {
    expect(parseGangChat(".hello all")).toBe("hello all");
    expect(parseGangChat(".   ")).toBeNull();
    expect(parseGangChat("hello")).toBeNull();
  });
});

describe("resolveGangChat", () => {
  const msg = makeMessages("Gangs>");

  async function world() {
    const h = await harness();
    await h.connect(S.owner, "O");
    await h.connect(S.bob, "Bob");
    await h.connect(S.carol, "Carol");
    h.gangs.svc.createGang("Wolves", S.owner);
    h.gangs.svc.addMember(1, S.bob, 100);
    h.gangs.svc.addMember(1, S.carol, 100);
    return h;
  }

  it("falls through (null) when the gang lacks the perk, the sender isn't a member, or lacks SEND_GANG_CHAT", async () => {
    const h = await world();
    expect(resolveGangChat(h.gangs, msg, S.bob, ".hi")).toBeNull();          // no perk
    h.gangs.svc.setGangStat(1, CHAT_STAT, 1);
    await h.connect(S.dave, "Dave");
    expect(resolveGangChat(h.gangs, msg, S.dave, ".hi")).toBeNull();         // not a member
    expect(resolveGangChat(h.gangs, msg, S.bob, "hi")).toBeNull();           // not gang chat
    h.gangs.svc.setRankPermission(1, 100, Perm.SEND_GANG_CHAT, false);
    expect(resolveGangChat(h.gangs, msg, S.bob, ".hi")).toBeNull();          // no permission
  });

  it("delivers to online members only, formatted", async () => {
    const h = await world();
    h.gangs.svc.setGangStat(1, CHAT_STAT, 1);
    h.disconnect(S.carol);
    expect(resolveGangChat(h.gangs, msg, S.bob, ".  raid now ")).toEqual({
      line: "[Wolves] Bob: raid now",
      recipients: [S.owner, S.bob],
    });
  });
});
