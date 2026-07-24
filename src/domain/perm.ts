import type { GangRank } from "./types";

const INVITE_OTHERS = 1 << 0, KICK_OTHERS = 1 << 1, BANK_DEPOSIT = 1 << 2, BANK_WITHDRAW = 1 << 3;
const PROMOTE_OTHERS = 1 << 4, DEMOTE_OTHERS = 1 << 5, PURCHASE_PERKS = 1 << 6, MANAGE_PERKS = 1 << 7;
const MANAGE_RANKS = 1 << 8, CREATE_RANKS = 1 << 9, VIEW_MEMBER_DETAILS = 1 << 12, SEND_GANG_CHAT = 1 << 14;
const MANAGE_INVITES = (1 << 13) | INVITE_OTHERS;
const ADMINISTRATOR =
  (1 << 10) | INVITE_OTHERS | KICK_OTHERS | BANK_DEPOSIT | BANK_WITHDRAW | PROMOTE_OTHERS |
  DEMOTE_OTHERS | PURCHASE_PERKS | MANAGE_PERKS | MANAGE_RANKS | CREATE_RANKS |
  VIEW_MEMBER_DETAILS | MANAGE_INVITES | SEND_GANG_CHAT;
const OWNER = (1 << 11) | ADMINISTRATOR;

export const Perm = {
  NONE: 0, INVITE_OTHERS, KICK_OTHERS, BANK_DEPOSIT, BANK_WITHDRAW, PROMOTE_OTHERS, DEMOTE_OTHERS,
  PURCHASE_PERKS, MANAGE_PERKS, MANAGE_RANKS, CREATE_RANKS, VIEW_MEMBER_DETAILS, SEND_GANG_CHAT,
  MANAGE_INVITES, ADMINISTRATOR, OWNER,
} as const;

const FRIENDLY: Record<string, string> = {
  INVITE_OTHERS: "Invite Others", KICK_OTHERS: "Kick Others", BANK_DEPOSIT: "Deposit Money",
  BANK_WITHDRAW: "Use Bank Funds", PROMOTE_OTHERS: "Promote Others", DEMOTE_OTHERS: "Demote Others",
  PURCHASE_PERKS: "Purchase Perks", MANAGE_PERKS: "Manage Perks", MANAGE_RANKS: "Manage Ranks",
  CREATE_RANKS: "Create Ranks", VIEW_MEMBER_DETAILS: "View Member Details",
  MANAGE_INVITES: "Manage Invites", SEND_GANG_CHAT: "Send Gang Chat",
};

export function hasPerm(perms: number, flag: number): boolean {
  return (perms & flag) === flag;
}

export function describe(perms: number): string {
  if (hasPerm(perms, OWNER)) return "Owner";
  if (hasPerm(perms, ADMINISTRATOR)) return "Administrator";
  const names = Object.entries(FRIENDLY)
    .filter(([k]) => hasPerm(perms, (Perm as Record<string, number>)[k]))
    .map(([, v]) => v);
  if (names.length === 0) return "No permissions";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** snake_case name → flag, derived from FRIENDLY's keys (the single-bit + MANAGE_INVITES perms). */
export const PERM_NAMES: Record<string, number> = Object.fromEntries(
  Object.keys(FRIENDLY).map((k) => [k.toLowerCase(), (Perm as Record<string, number>)[k]]),
);

export function permFromName(name: string): number | null {
  const flag = PERM_NAMES[name.toLowerCase()];
  return flag === undefined ? null : flag;
}

export function permName(flag: number): string | null {
  for (const [name, f] of Object.entries(PERM_NAMES)) if (f === flag) return name;
  return null;
}

/** The permissions a `rank_perm` command may toggle: single, human-managed flags. */
export const EDITABLE_PERMS: { name: string; flag: number; label: string }[] =
  Object.entries(FRIENDLY).map(([k, label]) => ({
    name: k.toLowerCase(), flag: (Perm as Record<string, number>)[k], label,
  }));

const MEMBER = BANK_DEPOSIT | VIEW_MEMBER_DETAILS | PURCHASE_PERKS | SEND_GANG_CHAT;
const OFFICER = MEMBER | MANAGE_INVITES | KICK_OTHERS;
const MANAGER = OFFICER | MANAGE_PERKS | MANAGE_RANKS | PROMOTE_OTHERS | DEMOTE_OTHERS | BANK_WITHDRAW;
const CO_OWNER = MANAGER | CREATE_RANKS;

export const DEFAULT_RANKS: GangRank[] = [
  { rank: 0, name: "Owner", permissions: OWNER },
  { rank: 10, name: "Co-Owner", permissions: CO_OWNER },
  { rank: 30, name: "Manager", permissions: MANAGER },
  { rank: 50, name: "Officer", permissions: OFFICER },
  { rank: 100, name: "Member", permissions: MEMBER },
];
