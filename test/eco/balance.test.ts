import { describe, it, expect } from "vitest";
import { BALANCE_STAT_ID, GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "../../src/eco/balance";

describe("balance descriptors", () => {
  it("share the upstream stat id and are scalar INT per scope", () => {
    expect(BALANCE_STAT_ID).toBe("gang_native_balance");
    expect(GANG_BALANCE_STAT).toEqual({ id: "gang_native_balance", scope: "gang", kind: "scalar", column: "INT" });
    expect(PLAYER_BALANCE_STAT).toEqual({ id: "gang_native_balance", scope: "player", kind: "scalar", column: "INT" });
  });
});
