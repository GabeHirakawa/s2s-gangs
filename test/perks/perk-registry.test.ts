import { describe, it, expect } from "vitest";
import { PerkRegistry } from "../../src/perks/perk-registry";
import { CAPACITY_PERK, GANGCHAT_PERK } from "../../src/perks/perk";

describe("PerkRegistry", () => {
  it("registers, gets, and lists perks", () => {
    const r = new PerkRegistry();
    r.register(CAPACITY_PERK); r.register(GANGCHAT_PERK);
    expect(r.get("gang_native_capacity")).toBe(CAPACITY_PERK);
    expect(r.get("nope")).toBeUndefined();
    expect(r.list().map((p) => p.id)).toEqual(["gang_native_capacity", "gang_native_chat"]);
  });
});
