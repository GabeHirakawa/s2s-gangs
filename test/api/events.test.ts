import { describe, it, expect } from "vitest";
import { GANG_EVENTS } from "../../src/api/events";

describe("GangEvents", () => {
  it("lists the ten events", () => {
    expect([...GANG_EVENTS].sort()).toEqual([
      "gang_created", "gang_credits_changed", "gang_deleted", "gang_renamed",
      "invite_created", "invite_revoked", "member_joined", "member_left",
      "member_rank_changed", "player_credits_changed",
    ]);
  });

  it("includes the two credit events", () => {
    expect(GANG_EVENTS).toContain("player_credits_changed");
    expect(GANG_EVENTS).toContain("gang_credits_changed");
  });
});
