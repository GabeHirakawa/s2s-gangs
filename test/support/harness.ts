import { makeTestDb } from "./sqlite";
import type { Db } from "../../src/store/db";
import { createGangs, type Gangs } from "../../src/service/gangs";
import { makeMessages } from "../../src/messages";
import type { CmdCtx, OnlinePlayer } from "../../src/commands/ctx";

/** Canonical SteamID64s for tests. */
export const S = {
  owner: "76561198000000001",
  bob: "76561198000000002",
  carol: "76561198000000003",
  dave: "76561198000000004",
} as const;

export interface Harness {
  db: Db;
  gangs: Gangs;
  events: Array<[string, unknown]>;
  logs: string[];
  delivered: Array<[string[], string]>;
  online: OnlinePlayer[];
  replies: string[];
  /** Mark a player online (loads/creates their row) and wait for the load. */
  connect(steam: string, name: string): Promise<void>;
  disconnect(steam: string): void;
  ctx(steam: string | null, args: string[]): CmdCtx;
  eventsNamed(name: string): unknown[];
}

export interface HarnessOptions {
  db?: Db;
  running?: (provider: string) => boolean;
  /** Don't wait for the boot load (to observe the not-ready window). */
  noFlush?: boolean;
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = opts.db ?? makeTestDb();
  const events: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const delivered: Array<[string[], string]> = [];
  const online: OnlinePlayer[] = [];
  const replies: string[] = [];
  const msg = makeMessages("Gangs>");
  const gangs = createGangs({
    emit: (e, p) => { events.push([e, p]); },
    log: (m) => { logs.push(m); },
    messages: () => msg,
    providerRunning: opts.running,
    deliver: (s, l) => { delivered.push([s, l]); },
  });
  gangs.svc.start(async () => db, "gang");
  if (!opts.noFlush) await gangs.svc.flush();
  return {
    db, gangs, events, logs, delivered, online, replies,
    async connect(steam, name) {
      if (!online.some((o) => o.steam === steam)) online.push({ steam, name });
      gangs.svc.playerConnected(steam, name);
      await gangs.svc.flush();
    },
    disconnect(steam) {
      const i = online.findIndex((o) => o.steam === steam);
      if (i >= 0) online.splice(i, 1);
      gangs.svc.playerDisconnected(steam);
    },
    ctx(steam, args) {
      return {
        steam, args, reply: (m) => { replies.push(m); }, gangs, msg,
        online: (q) => online.filter((o) => o.steam === q || o.name.toLowerCase().includes(q.toLowerCase())),
        nowSec: 1000,
      };
    },
    eventsNamed(name) { return events.filter(([e]) => e === name).map(([, p]) => p); },
  };
}

/** Assert a value is a clean protocol-2 wire value: JSON-only, no undefined, no non-finite numbers. */
export function isWireClean(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isWireClean);
  if (typeof v === "object") {
    if (Object.getPrototypeOf(v) !== Object.prototype) return false;
    return Object.values(v as Record<string, unknown>).every((x) => x !== undefined && isWireClean(x));
  }
  return false;
}
