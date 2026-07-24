export interface Gang { gangId: number; name: string; }
export interface GangPlayer {
  steam: string; name: string | null; gangId: number | null; gangRank: number | null;
}
export interface GangRank { rank: number; name: string; permissions: number; }
export interface Membership { player: GangPlayer; gang: Gang; rank: GangRank; }
export enum DoorPolicy { REQUEST_ONLY = 0, INVITE_ONLY = 1, OPEN = 2 }
export enum DeleteStrat { CANCEL = 0, DEMOTE_FAIL = 1, DEMOTE_KICK = 2 }
