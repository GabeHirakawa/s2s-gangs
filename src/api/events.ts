export interface GangEvents {
  gang_created: { gangId: number; name: string; ownerSteam: string };
  gang_deleted: { gangId: number };
  gang_renamed: { gangId: number; name: string };
  member_joined: { gangId: number; steam: string; rank: number };
  member_left: { gangId: number; steam: string; reason: "leave" | "kick" | "disband" };
  member_rank_changed: { gangId: number; steam: string; oldRank: number; newRank: number };
  invite_created: { gangId: number; inviter: string; invited: string };
  invite_revoked: { gangId: number; invited: string };
}

export type EmitFn = <K extends keyof GangEvents>(event: K, payload: GangEvents[K]) => void;

export const GANG_EVENTS: readonly (keyof GangEvents)[] = [
  "gang_created", "gang_deleted", "gang_renamed", "member_joined",
  "member_left", "member_rank_changed", "invite_created", "invite_revoked",
];
