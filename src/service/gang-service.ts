import type { Db } from "../store/db";
import { GangsRepo, type Snapshot, type StatRow } from "../store/repo";
import { WriteQueue } from "../store/write-queue";
import type { DialectName } from "../store/dialect";
import {
  type CachedStat, type StatScope, INVITATION_STAT, PENDING_STAT,
} from "../store/stats";
import type { Gang, GangPlayer, GangRank } from "../domain/types";
import { DeleteStrat } from "../domain/types";
import { DEFAULT_RANKS, Perm, hasPerm } from "../domain/perm";
import {
  type InvitationData, type PendingInvitationData,
  addInvitation, addPending, emptyInvitation, invitedList, pendingList, removeInvitation, removePending,
} from "../domain/invitation";
import type { Emit, ForwardName, ForwardPayloads } from "./events";

export interface ServiceOptions {
  /** Forward emitter (the publish handle's `emit`). Exceptions are caught and logged. */
  emit?: Emit;
  log?: (message: string) => void;
}

export type LeaveReason = "leave" | "kick" | "disband";

/** Max stored gang / rank name length (the columns are VARCHAR(255)). */
export const MAX_NAME = 255;

/**
 * The Gangs state: a synchronous in-memory cache over the database.
 *
 * - `start()` enqueues the boot op (open DB → ensure tables → load every gang, rank, gang stat and
 *   gang member + their player stats). Until it finishes `isReady()` is false, reads return
 *   empty/null and every mutation returns false.
 * - Non-member players are cached while online: `playerConnected()` enqueues a load of their row
 *   (created if missing) and stats; `playerDisconnected()` evicts a non-member again.
 * - Every mutation updates the cache first (so it is visible synchronously) and then enqueues its
 *   database write on ONE ordered {@link WriteQueue}. Write failures are logged, never thrown.
 *
 * Cached objects are treated as immutable — updates replace them — so a write enqueued with a
 * reference to one always persists the value as of enqueue time.
 */
export class GangService {
  readonly queue: WriteQueue;
  private readonly log: (message: string) => void;
  private emitFn: Emit | undefined;
  private repo: GangsRepo | null = null;
  private db: Db | null = null;
  private ready = false;

  private readonly gangs = new Map<number, Gang>();
  private readonly ranks = new Map<number, GangRank[]>();
  private readonly players = new Map<string, GangPlayer>();
  private readonly memberIndex = new Map<number, Set<string>>();
  private readonly gangStats = new Map<number, Map<string, CachedStat>>();
  private readonly playerStats = new Map<string, Map<string, CachedStat>>();
  private readonly online = new Set<string>();
  private readonly loading = new Set<string>();

  constructor(opts: ServiceOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.emitFn = opts.emit;
    this.queue = new WriteQueue(this.log);
  }

  /** Late-bind the emitter (the publish handle exists only after publish()). */
  setEmitter(emit: Emit): void { this.emitFn = emit; }

  emit<K extends ForwardName>(event: K, payload: ForwardPayloads[K]): void {
    if (!this.emitFn) return;
    try { this.emitFn(event, payload); }
    catch (e) { this.log(`[gangs] emit ${event} failed: ${String(e)}`); }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  /** Enqueue the boot op. `onReady` runs (after OnReady is emitted) once the cache is loaded. */
  start(open: () => Promise<Db>, prefix: string, dialect: DialectName = "sqlite", onReady?: () => void): void {
    this.queue.enqueue("boot", async () => {
      const db = await open();
      this.db = db;
      const repo = new GangsRepo(db, prefix, dialect);
      await repo.ensureTables();
      const snap = await repo.loadAll();
      this.repo = repo;
      this.applySnapshot(snap);
      this.ready = true;
      this.log(`[gangs] cache loaded: ${this.gangs.size} gangs, ${this.players.size} members`);
      this.emit("OnReady", { gangs: this.gangs.size });
      onReady?.();
    });
  }

  /** Resolves once every queued write/load has settled. */
  flush(): Promise<void> { return this.queue.flush(); }

  /**
   * Stop serving, then drain the queue and close the database. Best effort (used at plugin end):
   * if the host tears the context down first, the still-queued writes are lost — so the count at
   * the moment of shutdown is logged to make that visible.
   */
  shutdown(): Promise<void> {
    const db = this.db;
    this.ready = false;
    const queued = this.queue.size;
    this.log(queued > 0
      ? `[gangs] shutting down with ${queued} database write(s) still queued; they are lost if the plugin context is torn down before they finish`
      : "[gangs] shutting down with no queued database writes");
    return this.queue.flush().then(() => db?.close?.()).then(() => undefined);
  }

  isReady(): boolean { return this.ready; }

  /** True once `steam`'s row is in the cache (members always; others after their connect load). */
  isLoaded(steam: string): boolean { return this.ready && this.players.has(steam); }

  private applySnapshot(s: Snapshot): void {
    for (const g of s.gangs) this.gangs.set(g.gangId, g);
    for (const { gangId, rank } of s.ranks) {
      if (!this.gangs.has(gangId)) continue;
      const list = this.ranks.get(gangId) ?? [];
      list.push(rank);
      this.ranks.set(gangId, list);
    }
    for (const list of this.ranks.values()) list.sort((a, b) => a.rank - b.rank);
    for (const p of s.members) {
      // A dangling membership (gang row gone) is treated as gangless.
      const valid = p.gangId !== null && p.gangRank !== null && this.gangs.has(p.gangId);
      this.putPlayer(valid ? p : { ...p, gangId: null, gangRank: null });
    }
    for (const r of s.gangStats) {
      const id = Number(r.owner);
      if (this.gangs.has(id)) this.statsFor("gang", id).set(r.statId, r.value);
    }
    this.applyPlayerStats(s.memberStats);
  }

  private applyPlayerStats(rows: StatRow[]): void {
    for (const r of rows) if (this.players.has(r.owner)) this.statsFor("player", r.owner).set(r.statId, r.value);
  }

  // ── connections ───────────────────────────────────────────────────────────────────────────────

  /** A real (authenticated) player is online: load/create their row and refresh their name. */
  playerConnected(steam: string, name: string): void {
    this.online.add(steam);
    const cached = this.players.get(steam);
    if (cached) { this.refreshName(cached, name); return; }
    if (this.loading.has(steam)) return;
    this.loading.add(steam);
    this.queue.enqueue(`load ${steam}`, async () => {
      try {
        const repo = this.requireRepo();
        const snap = await repo.loadPlayer(steam, name || null);
        const now = this.players.get(steam);
        if (now) { this.refreshName(now, name); return; }
        if (!this.online.has(steam) || !snap.player) return; // left before the load finished
        const p = snap.player;
        const valid = p.gangId !== null && p.gangRank !== null && this.gangs.has(p.gangId);
        this.putPlayer(valid ? p : { ...p, gangId: null, gangRank: null });
        this.applyPlayerStats(snap.stats);
        this.refreshName(this.players.get(steam)!, name);
      } finally {
        this.loading.delete(steam);
      }
    });
  }

  /** Evict a non-member's cache entry when they leave (members stay cached). */
  playerDisconnected(steam: string): void {
    this.online.delete(steam);
    const p = this.players.get(steam);
    if (!p || p.gangId !== null || this.loading.has(steam)) return;
    this.players.delete(steam);
    this.playerStats.delete(steam);
  }

  isOnline(steam: string): boolean { return this.online.has(steam); }

  private refreshName(p: GangPlayer, name: string): void {
    if (!name || p.name === name) return;
    this.putPlayer({ ...p, name });
    this.persistPlayer(steamOf(p));
  }

  // ── internal plumbing ─────────────────────────────────────────────────────────────────────────

  private requireRepo(): GangsRepo {
    if (!this.repo) throw new Error("database not open");
    return this.repo;
  }

  private write(label: string, fn: (repo: GangsRepo) => Promise<void>): void {
    this.queue.enqueue(label, () => fn(this.requireRepo()));
  }

  private persistPlayer(steam: string): void {
    const p = this.players.get(steam);
    if (!p) return;
    this.write(`player ${steam}`, (r) => r.upsertPlayer(p));
  }

  /** Replace a player's cache row, keeping the member index in sync. */
  private putPlayer(p: GangPlayer): void {
    const prev = this.players.get(p.steam);
    if (prev && prev.gangId !== null) this.memberIndex.get(prev.gangId)?.delete(p.steam);
    this.players.set(p.steam, p);
    if (p.gangId !== null) {
      let set = this.memberIndex.get(p.gangId);
      if (!set) { set = new Set(); this.memberIndex.set(p.gangId, set); }
      set.add(p.steam);
    }
  }

  private statsFor(scope: "gang", owner: number): Map<string, CachedStat>;
  private statsFor(scope: "player", owner: string): Map<string, CachedStat>;
  private statsFor(scope: StatScope, owner: number | string): Map<string, CachedStat> {
    if (scope === "gang") {
      let m = this.gangStats.get(owner as number);
      if (!m) { m = new Map(); this.gangStats.set(owner as number, m); }
      return m;
    }
    let m = this.playerStats.get(owner as string);
    if (!m) { m = new Map(); this.playerStats.set(owner as string, m); }
    return m;
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────

  allGangs(): Gang[] { return this.ready ? [...this.gangs.values()] : []; }
  getGang(gangId: number): Gang | null { return (this.ready && this.gangs.get(gangId)) || null; }

  getPlayer(steam: string): GangPlayer | null { return (this.ready && this.players.get(steam)) || null; }

  gangOf(steam: string): Gang | null {
    const p = this.getPlayer(steam);
    return p && p.gangId !== null ? this.getGang(p.gangId) : null;
  }

  /** Members of a gang, owner-first then by name. */
  membersOf(gangId: number): GangPlayer[] {
    if (!this.ready) return [];
    const set = this.memberIndex.get(gangId);
    if (!set) return [];
    const out: GangPlayer[] = [];
    for (const s of set) { const p = this.players.get(s); if (p) out.push(p); }
    return out.sort((a, b) => (a.gangRank ?? 0) - (b.gangRank ?? 0) || (a.name ?? a.steam).localeCompare(b.name ?? b.steam));
  }

  memberCount(gangId: number): number { return this.ready ? this.memberIndex.get(gangId)?.size ?? 0 : 0; }

  /** Ranks of a gang, ordered owner-first (ascending rank number). */
  ranksOf(gangId: number): GangRank[] { return this.ready ? [...(this.ranks.get(gangId) ?? [])] : []; }

  getRank(gangId: number, rank: number): GangRank | null {
    return this.ranksOf(gangId).find((r) => r.rank === rank) ?? null;
  }

  /** The rank object of a member, or null if not in a gang. */
  rankOfMember(steam: string): GangRank | null {
    const p = this.getPlayer(steam);
    if (!p || p.gangId === null || p.gangRank === null) return null;
    return this.getRank(p.gangId, p.gangRank);
  }

  /** True if `steam` is a member whose rank grants every bit of `perm`. */
  hasPermission(steam: string, perm: number): boolean {
    const r = this.rankOfMember(steam);
    return r !== null && hasPerm(r.permissions, perm);
  }

  /** The rank new members join at (the lowest-standing one). */
  joinRank(gangId: number): GangRank | null {
    const list = this.ranksOf(gangId);
    return list.length ? list[list.length - 1] : null;
  }

  /** The lowest-standing rank that holds `perm`, or null. */
  rankNeeded(gangId: number, perm: number): GangRank | null {
    const withPerm = this.ranksOf(gangId).filter((r) => hasPerm(r.permissions, perm));
    return withPerm.length ? withPerm[withPerm.length - 1] : null;
  }

  /** A member of `gangId` by exact SteamID, else by a unique case-insensitive name substring. */
  findInGang(gangId: number, query: string): GangPlayer | null {
    const members = this.membersOf(gangId);
    const bySteam = members.filter((p) => p.steam === query);
    if (bySteam.length === 1) return bySteam[0];
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const byName = members.filter((p) => p.name !== null && p.name.toLowerCase().includes(q));
    return byName.length === 1 ? byName[0] : null;
  }

  /** A gang by exact (case-insensitive) name, else by a unique partial match. */
  findGangByName(query: string): Gang | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const all = this.allGangs();
    const exact = all.filter((g) => g.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0];
    const partial = all.filter((g) => g.name.toLowerCase().includes(q));
    return partial.length === 1 ? partial[0] : null;
  }

  gangStat(gangId: number, statId: string): CachedStat {
    if (!this.ready) return null;
    return this.gangStats.get(gangId)?.get(statId) ?? null;
  }

  playerStat(steam: string, statId: string): CachedStat {
    if (!this.ready) return null;
    return this.playerStats.get(steam)?.get(statId) ?? null;
  }

  // ── stat writes ───────────────────────────────────────────────────────────────────────────────

  /** Set (or with `null`, clear) a gang stat. False if not ready or the gang is unknown. */
  setGangStat(gangId: number, statId: string, value: CachedStat): boolean {
    if (!this.ready || !this.gangs.has(gangId)) return false;
    const m = this.statsFor("gang", gangId);
    if (value === null) m.delete(statId); else m.set(statId, value);
    this.write(`gang stat ${gangId}/${statId}`, (r) => r.writeStat("gang", gangId, statId, value));
    return true;
  }

  /** Set (or clear) a player stat. False if not ready or the player is not cached. */
  setPlayerStat(steam: string, statId: string, value: CachedStat): boolean {
    if (!this.ready || !this.players.has(steam)) return false;
    const m = this.statsFor("player", steam);
    if (value === null) m.delete(statId); else m.set(statId, value);
    this.write(`player stat ${steam}/${statId}`, (r) => r.writeStat("player", steam, statId, value));
    return true;
  }

  // ── gangs ─────────────────────────────────────────────────────────────────────────────────────

  /** Create a gang owned by `ownerSteam` (must be cached and gangless); emits OnGangCreated + OnMemberJoined. */
  createGang(name: string, ownerSteam: string): Gang | null {
    if (!this.ready) return null;
    const clean = name.trim();
    if (!clean || clean.length > MAX_NAME || this.isNameTaken(clean)) return null;
    const owner = this.players.get(ownerSteam);
    if (!owner || owner.gangId !== null) return null;

    let max = 0;
    for (const id of this.gangs.keys()) if (id > max) max = id;
    const gang: Gang = { gangId: max + 1, name: clean };
    const ranks = DEFAULT_RANKS.map((r) => ({ ...r }));
    this.gangs.set(gang.gangId, gang);
    this.ranks.set(gang.gangId, ranks);
    this.putPlayer({ ...owner, gangId: gang.gangId, gangRank: 0 });
    const ownerRow = this.players.get(ownerSteam)!;
    this.write(`create gang ${gang.gangId}`, async (r) => {
      await r.insertGang(gang);
      for (const rank of ranks) await r.insertRank(gang.gangId, rank);
      await r.upsertPlayer(ownerRow);
    });
    this.emit("OnGangCreated", { gangId: gang.gangId, name: gang.name });
    this.emit("OnMemberJoined", { gangId: gang.gangId, steamId: ownerSteam, rank: 0 });
    return gang;
  }

  isNameTaken(name: string, exceptGangId?: number): boolean {
    const q = name.trim().toLowerCase();
    for (const g of this.gangs.values()) if (g.gangId !== exceptGangId && g.name.toLowerCase() === q) return true;
    return false;
  }

  /** Rename a gang; emits OnGangRenamed. */
  renameGang(gangId: number, name: string): boolean {
    const gang = this.getGang(gangId);
    const clean = name.trim();
    if (!gang || !clean || clean.length > MAX_NAME || this.isNameTaken(clean, gangId)) return false;
    if (gang.name === clean) return true;
    this.gangs.set(gangId, { gangId, name: clean });
    this.write(`rename gang ${gangId}`, (r) => r.renameGang(gangId, clean));
    this.emit("OnGangRenamed", { gangId, name: clean });
    return true;
  }

  /** Delete a gang and everything attached; emits OnMemberLeft("disband") per member, then OnGangDisbanded. */
  disbandGang(gangId: number): boolean {
    const gang = this.getGang(gangId);
    if (!gang) return false;
    const members = this.membersOf(gangId);
    for (const m of members) this.putPlayer({ ...m, gangId: null, gangRank: null });
    this.memberIndex.delete(gangId);
    this.gangs.delete(gangId);
    this.ranks.delete(gangId);
    this.gangStats.delete(gangId);
    // Drop this gang from every cached player's pending invitations.
    for (const [steam, stats] of this.playerStats) {
      const pend = stats.get(PENDING_STAT);
      if (!pend || typeof pend !== "object") continue;
      const data = pend as unknown as PendingInvitationData;
      if (pendingList(data).includes(gangId)) this.setPlayerStat(steam, PENDING_STAT, { ...removePending(data, gangId) });
    }
    this.write(`disband gang ${gangId}`, (r) => r.deleteGang(gangId));
    for (const m of members) this.emit("OnMemberLeft", { gangId, steamId: m.steam, reason: "disband" });
    this.emit("OnGangDisbanded", { gangId, name: gang.name });
    // Evict members who are offline and no longer belong anywhere.
    for (const m of members) if (!this.online.has(m.steam)) this.playerDisconnected(m.steam);
    return true;
  }

  // ── membership ────────────────────────────────────────────────────────────────────────────────

  /** Put a cached, gangless player into `gangId` at `rank` (must exist); emits OnMemberJoined. */
  addMember(gangId: number, steam: string, rank: number): boolean {
    const p = this.getPlayer(steam);
    if (!p || p.gangId !== null || !this.getGang(gangId) || !this.getRank(gangId, rank)) return false;
    this.putPlayer({ ...p, gangId, gangRank: rank });
    this.persistPlayer(steam);
    this.emit("OnMemberJoined", { gangId, steamId: steam, rank });
    return true;
  }

  /** Take a member out of their gang; emits OnMemberLeft. The owner (rank 0) cannot be removed. */
  removeMember(steam: string, reason: LeaveReason): boolean {
    const p = this.getPlayer(steam);
    if (!p || p.gangId === null || p.gangRank === 0) return false;
    const gangId = p.gangId;
    this.putPlayer({ ...p, gangId: null, gangRank: null });
    this.persistPlayer(steam);
    this.emit("OnMemberLeft", { gangId, steamId: steam, reason });
    if (!this.online.has(steam)) this.playerDisconnected(steam);
    return true;
  }

  /** Move a member to another existing rank of their gang; emits OnMemberRankChanged. */
  setMemberRank(steam: string, newRank: number): boolean {
    const p = this.getPlayer(steam);
    if (!p || p.gangId === null || p.gangRank === null || !this.getRank(p.gangId, newRank)) return false;
    const oldRank = p.gangRank;
    if (oldRank === newRank) return true;
    this.putPlayer({ ...p, gangRank: newRank });
    this.persistPlayer(steam);
    this.emit("OnMemberRankChanged", { gangId: p.gangId, steamId: steam, oldRank, newRank });
    return true;
  }

  // ── ranks ─────────────────────────────────────────────────────────────────────────────────────

  createRank(gangId: number, name: string, rank: number, permissions: number): GangRank | null {
    if (!this.getGang(gangId) || !Number.isSafeInteger(rank) || rank < 0) return null;
    const clean = name.trim();
    if (!clean || clean.length > MAX_NAME) return null;
    if (rank > 0 && hasPerm(permissions, Perm.OWNER)) return null; // only rank 0 may be OWNER
    if (this.getRank(gangId, rank)) return null;
    const obj: GangRank = { rank, name: clean, permissions };
    const list = [...(this.ranks.get(gangId) ?? []), obj].sort((a, b) => a.rank - b.rank);
    this.ranks.set(gangId, list);
    this.write(`create rank ${gangId}/${rank}`, (r) => r.insertRank(gangId, obj));
    return obj;
  }

  updateRank(gangId: number, rank: GangRank): boolean {
    if (rank.rank < 0 || (rank.rank > 0 && hasPerm(rank.permissions, Perm.OWNER))) return false;
    const existing = this.getRank(gangId, rank.rank);
    const clean = rank.name.trim();
    if (!existing || !clean || clean.length > MAX_NAME) return false;
    const obj: GangRank = { rank: rank.rank, name: clean, permissions: rank.permissions };
    this.ranks.set(gangId, this.ranksOf(gangId).map((r) => (r.rank === obj.rank ? obj : r)));
    this.write(`update rank ${gangId}/${obj.rank}`, (r) => r.updateRank(gangId, obj));
    return true;
  }

  setRankPermission(gangId: number, rank: number, perm: number, on: boolean): boolean {
    const r = this.getRank(gangId, rank);
    if (!r) return false;
    return this.updateRank(gangId, { ...r, permissions: on ? (r.permissions | perm) : (r.permissions & ~perm) });
  }

  /**
   * Delete a rank. CANCEL refuses if anyone holds it; DEMOTE_FAIL moves holders to the next lower
   * rank (refusing if there is none); DEMOTE_KICK demotes, or kicks when there is no lower rank.
   */
  deleteRank(gangId: number, rank: number, strat: DeleteStrat): boolean {
    if (rank <= 0 || !this.getRank(gangId, rank)) return false;
    const holders = this.membersOf(gangId).filter((p) => p.gangRank === rank);
    if (strat === DeleteStrat.CANCEL && holders.length > 0) return false;
    const lower = this.ranksOf(gangId).find((r) => r.rank > rank) ?? null;
    if (strat === DeleteStrat.DEMOTE_FAIL && lower === null && holders.length > 0) return false;
    for (const p of holders) {
      if (lower) this.setMemberRank(p.steam, lower.rank);
      else this.removeMember(p.steam, "kick");
    }
    this.ranks.set(gangId, this.ranksOf(gangId).filter((r) => r.rank !== rank));
    this.write(`delete rank ${gangId}/${rank}`, (r) => r.deleteRank(gangId, rank));
    return true;
  }

  // ── invitations (upstream record stats) ───────────────────────────────────────────────────────

  private invitation(gangId: number): InvitationData | null {
    const v = this.gangStat(gangId, INVITATION_STAT);
    return v && typeof v === "object" ? (v as unknown as InvitationData) : null;
  }

  private pending(steam: string): PendingInvitationData | null {
    const v = this.playerStat(steam, PENDING_STAT);
    return v && typeof v === "object" ? (v as unknown as PendingInvitationData) : null;
  }

  /** Record an outgoing invite (and the target's pending entry when they are cached). */
  createInvite(gangId: number, inviter: string, invited: string, nowSec: number): boolean {
    if (!this.getGang(gangId)) return false;
    const data = this.invitation(gangId) ?? emptyInvitation();
    if (!invitedList(data).includes(invited))
      this.setGangStat(gangId, INVITATION_STAT, { ...addInvitation(data, inviter, invited, nowSec) });
    if (this.players.has(invited)) {
      const pend = this.pending(invited) ?? { InvitingGangs: "" };
      if (!pendingList(pend).includes(gangId)) this.setPlayerStat(invited, PENDING_STAT, { ...addPending(pend, gangId) });
    }
    return true;
  }

  revokeInvite(gangId: number, invited: string): boolean {
    if (!this.ready) return false;
    const data = this.invitation(gangId);
    if (data && invitedList(data).includes(invited))
      this.setGangStat(gangId, INVITATION_STAT, { ...removeInvitation(data, invited) });
    const pend = this.pending(invited);
    if (pend && pendingList(pend).includes(gangId))
      this.setPlayerStat(invited, PENDING_STAT, { ...removePending(pend, gangId) });
    return true;
  }

  /** SteamIDs a gang has invited. */
  outgoingInvites(gangId: number): string[] {
    const data = this.invitation(gangId);
    return data ? invitedList(data) : [];
  }

  /** Gangs that currently invite `steam` (a gang's own outgoing list is authoritative). */
  pendingInvites(steam: string): number[] {
    const pend = this.pending(steam);
    const fromPending = pend ? pendingList(pend) : [];
    return fromPending.filter((g) => this.outgoingInvites(g).includes(steam));
  }
}

const steamOf = (p: GangPlayer): string => p.steam;
