import { describe, it, expect } from "vitest";
import {
  emptyInvitation, addInvitation, removeInvitation, invitedList,
  addPending, removePending, pendingList,
} from "../../src/domain/invitation";

describe("invitation data", () => {
  it("adds and lists invited steams as comma-joined strings", () => {
    let d = emptyInvitation();
    d = addInvitation(d, "111", "222", 1000);
    d = addInvitation(d, "111", "333", 1001);
    expect(d.InvitedSteams).toBe("222,333");
    expect(d.InviterSteams).toBe("111,111");
    expect(d.Dates).toBe("1000,1001");
    expect(invitedList(d)).toEqual(["222", "333"]);
  });
  it("removes an invite by keeping the parallel lists aligned", () => {
    let d = addInvitation(addInvitation(emptyInvitation(), "1", "2", 10), "1", "3", 20);
    d = removeInvitation(d, "2");
    expect(invitedList(d)).toEqual(["3"]);
    expect(d.InviterSteams).toBe("1");
    expect(d.Dates).toBe("20");
  });
  it("pending gangs add/remove/list as ints", () => {
    let p = addPending({ InvitingGangs: "" }, 5);
    p = addPending(p, 7);
    expect(pendingList(p)).toEqual([5, 7]);
    p = removePending(p, 5);
    expect(pendingList(p)).toEqual([7]);
  });
});
