import { describe, it, expect } from "vitest";
import { DoorPolicy, DeleteStrat } from "../../src/domain/types";

describe("domain enums", () => {
  it("DoorPolicy order matches upstream", () => {
    expect([DoorPolicy.REQUEST_ONLY, DoorPolicy.INVITE_ONLY, DoorPolicy.OPEN]).toEqual([0, 1, 2]);
  });
  it("DeleteStrat order matches upstream", () => {
    expect([DeleteStrat.CANCEL, DeleteStrat.DEMOTE_FAIL, DeleteStrat.DEMOTE_KICK]).toEqual([0, 1, 2]);
  });
});
