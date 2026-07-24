import { describe, it, expect } from "vitest";
import { GANG_EVENTS } from "../../src/api/events";

describe("GangEvents", () => {
  it("lists the eight lifecycle events", () => {
    expect([...GANG_EVENTS].sort()).toEqual([
      "gang_created", "gang_deleted", "gang_renamed", "invite_created",
      "invite_revoked", "member_joined", "member_left", "member_rank_changed",
    ]);
  });
});
