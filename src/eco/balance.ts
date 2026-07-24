import type { StatDescriptor } from "../db/instance.repo";

/** Upstream BalanceStat.STAT_ID — one id, used for both player wallet and gang bank. */
export const BALANCE_STAT_ID = "gang_native_balance";

export const GANG_BALANCE_STAT: StatDescriptor = {
  id: BALANCE_STAT_ID, scope: "gang", kind: "scalar", column: "INT",
};
export const PLAYER_BALANCE_STAT: StatDescriptor = {
  id: BALANCE_STAT_ID, scope: "player", kind: "scalar", column: "INT",
};
