import type { SqlValue } from "./db";

/** A public stat value (the `@gangs/api` StatValue). `null` means "absent". */
export type StatValue = string | number | boolean | null;
/** A structured native stat (a multi-column upstream instance table), e.g. gang invitations. */
export type StatRecord = Record<string, SqlValue>;
/** What the cache holds per (owner, statId). Records only ever come from record descriptors. */
export type CachedStat = StatValue | StatRecord;

export type ColumnType = "INT" | "BIGINT" | "VARCHAR(255)" | "REAL" | "BOOLEAN";
export type StatScope = "gang" | "player";
export interface ScalarStat { id: string; scope: StatScope; kind: "scalar"; column: ColumnType; }
export interface RecordStat { id: string; scope: StatScope; kind: "record"; columns: Record<string, ColumnType>; }
export type StatDescriptor = ScalarStat | RecordStat;

// ── native stat ids (upstream names; each has its own upstream-compatible instance table) ─────────
/** Upstream BalanceStat.STAT_ID — one id, used for both the player wallet and the gang bank. */
export const BALANCE_STAT = "gang_native_balance";
export const CAPACITY_STAT = "gang_native_capacity";
export const CHAT_STAT = "gang_native_chat";
export const MOTD_STAT = "gang_native_motd";
export const DOOR_POLICY_STAT = "gang_door_policy";
export const INVITATION_STAT = "gang_invitation";
export const PENDING_STAT = "pending_invitation";

export const NATIVE_GANG_STATS: StatDescriptor[] = [
  { id: BALANCE_STAT, scope: "gang", kind: "scalar", column: "INT" },
  { id: CAPACITY_STAT, scope: "gang", kind: "scalar", column: "INT" },
  { id: CHAT_STAT, scope: "gang", kind: "scalar", column: "INT" },
  { id: MOTD_STAT, scope: "gang", kind: "scalar", column: "VARCHAR(255)" },
  { id: DOOR_POLICY_STAT, scope: "gang", kind: "scalar", column: "INT" },
  {
    id: INVITATION_STAT, scope: "gang", kind: "record",
    columns: {
      InvitedSteams: "VARCHAR(255)", InviterSteams: "VARCHAR(255)",
      RequestedSteams: "VARCHAR(255)", Dates: "VARCHAR(255)", MaxAmo: "INT",
    },
  },
];
export const NATIVE_PLAYER_STATS: StatDescriptor[] = [
  { id: BALANCE_STAT, scope: "player", kind: "scalar", column: "INT" },
  { id: PENDING_STAT, scope: "player", kind: "record", columns: { InvitingGangs: "VARCHAR(255)" } },
];

export function nativeDescriptor(scope: StatScope, statId: string): StatDescriptor | undefined {
  return (scope === "gang" ? NATIVE_GANG_STATS : NATIVE_PLAYER_STATS).find((d) => d.id === statId);
}

export const columnsOf = (d: StatDescriptor): Array<[string, ColumnType]> =>
  d.kind === "scalar" ? [[d.id, d.column]] : Object.entries(d.columns);

export function isRecord(v: CachedStat | undefined): v is StatRecord {
  return typeof v === "object" && v !== null;
}

/** Does `value` fit a native scalar column? (Public writes to native stats are type-checked.) */
export function fitsColumn(column: ColumnType, value: StatValue): boolean {
  if (value === null) return true;
  switch (column) {
    case "INT": case "BIGINT": return typeof value === "number" && Number.isSafeInteger(value);
    case "REAL": return typeof value === "number" && Number.isFinite(value);
    case "BOOLEAN": return typeof value === "boolean";
    case "VARCHAR(255)": return typeof value === "string" && value.length <= 255;
  }
}

/** Generic (non-native) stats live in one key/value table per scope; values are JSON text. */
export function encodeValue(v: StatValue): string { return JSON.stringify(v); }
export function decodeValue(text: SqlValue): StatValue {
  if (typeof text !== "string") return text;
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch { /* fall through: treat as a raw string */ }
  return text;
}

/** Normalize a value read from a native scalar column (SQLite/MySQL BOOLEAN come back as 0/1). */
export function fromColumn(column: ColumnType, v: SqlValue): StatValue {
  if (v === null) return null;
  if (column === "BOOLEAN") return v === true || v === 1 || v === "1";
  if (column === "INT" || column === "BIGINT" || column === "REAL") return typeof v === "number" ? v : Number(v);
  return String(v);
}
