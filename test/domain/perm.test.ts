import { describe, it, expect } from "vitest";
import { Perm, hasPerm, DEFAULT_RANKS } from "../../src/domain/perm";
import { permFromName, permName, EDITABLE_PERMS, PERM_NAMES } from "../../src/domain/perm";

describe("Perm", () => {
  it("base bit values match upstream", () => {
    expect(Perm.INVITE_OTHERS).toBe(1 << 0);
    expect(Perm.SEND_GANG_CHAT).toBe(1 << 14);
  });
  it("MANAGE_INVITES includes INVITE_OTHERS", () => {
    expect(hasPerm(Perm.MANAGE_INVITES, Perm.INVITE_OTHERS)).toBe(true);
  });
  it("OWNER includes ADMINISTRATOR which includes every base perm", () => {
    for (const flag of [Perm.INVITE_OTHERS, Perm.KICK_OTHERS, Perm.MANAGE_RANKS, Perm.SEND_GANG_CHAT])
      expect(hasPerm(Perm.OWNER, flag)).toBe(true);
    expect(hasPerm(Perm.OWNER, Perm.ADMINISTRATOR)).toBe(true);
  });
  it("DEFAULT_RANKS has owner at rank 0 with OWNER perms and member at 100", () => {
    expect(DEFAULT_RANKS[0]).toMatchObject({ rank: 0, permissions: Perm.OWNER });
    expect(DEFAULT_RANKS.at(-1)).toMatchObject({ rank: 100, name: "Member" });
  });
  it("pins the Member permission bitfield (wire format)", () => {
    const member = DEFAULT_RANKS.find((r) => r.rank === 100)!;
    expect(member.permissions).toBe(
      Perm.BANK_DEPOSIT | Perm.VIEW_MEMBER_DETAILS | Perm.PURCHASE_PERKS | Perm.SEND_GANG_CHAT
    );
  });
});

describe("perm names", () => {
  it("round-trips snake_case names to flags", () => {
    expect(permFromName("invite_others")).toBe(Perm.INVITE_OTHERS);
    expect(permFromName("bank_withdraw")).toBe(Perm.BANK_WITHDRAW);
    expect(permFromName("nonsense")).toBeNull();
    expect(permName(Perm.KICK_OTHERS)).toBe("kick_others");
  });
  it("EDITABLE_PERMS excludes composed OWNER/ADMINISTRATOR and NONE", () => {
    const flags = EDITABLE_PERMS.map((p) => p.flag);
    expect(flags).not.toContain(Perm.OWNER);
    expect(flags).not.toContain(Perm.ADMINISTRATOR);
    expect(flags).not.toContain(Perm.NONE);
    expect(Object.keys(PERM_NAMES)).toContain("send_gang_chat");
  });
});
