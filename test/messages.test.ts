import { describe, it, expect } from "vitest";
import { makeMessages } from "../src/messages";

describe("messages", () => {
  it("formats with the configured tag and interpolates values", () => {
    const msg = makeMessages("Gangs>");
    expect(msg.created("Wolves", 3)).toContain("Wolves");
    expect(msg.created("Wolves", 3)).toContain("Gangs>");
    expect(msg.noPermission("Kick Others")).toContain("Kick Others");
  });
});
