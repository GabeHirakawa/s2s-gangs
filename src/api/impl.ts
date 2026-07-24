import type { GangManager } from "../managers/gang-manager";
import type { PlayerManager } from "../managers/player-manager";
import type { RankManager } from "../managers/rank-manager";
import type { StatManager } from "../managers/stat-manager";
import type { EmitFn } from "./events";
import type { GangsApi } from "../../api";
import type { Membership } from "../domain/types";
import {
  emptyInvitation, addInvitation, removeInvitation, invitedList,
  addPending, removePending, pendingList,
  type InvitationData, type PendingInvitationData,
} from "../domain/invitation";
import { EcoManager } from "../eco/eco-manager";

const INVITATION = "gang_invitation";
const PENDING = "pending_invitation";

export interface Managers {
  gangs: GangManager; players: PlayerManager; ranks: RankManager; stats: StatManager;
}

export function buildGangsApi(m: Managers, emit: EmitFn): GangsApi {
  const eco = new EcoManager(m.stats, m.players, m.ranks, {
    player: (steam, balance, delta, reason) => emit("player_credits_changed", { steam, balance, delta, reason }),
    gang: (gangId, balance, delta, reason) => emit("gang_credits_changed", { gangId, balance, delta, reason }),
  });
  return {
    gangs: {
      getAll: () => m.gangs.getGangs(),
      get: (id) => m.gangs.getGang(id),
      getByMember: (steam) => m.gangs.getGangByMember(steam),
      async create(name, ownerSteam) {
        const gang = await m.gangs.createGang(name, ownerSteam);
        if (gang) emit("gang_created", { gangId: gang.gangId, name: gang.name, ownerSteam });
        return gang;
      },
      async updateName(gangId, name) {
        const ok = await m.gangs.updateGang({ gangId, name });
        if (ok) emit("gang_renamed", { gangId, name });
        return ok;
      },
      async delete(id) {
        const members = await m.players.getMembers(id); // capture before the cascade clears them
        const ok = await m.gangs.deleteGang(id);
        if (ok) {
          for (const mem of members)
            emit("member_left", { gangId: id, steam: mem.steam, reason: "disband" });
          emit("gang_deleted", { gangId: id });
        }
        return ok;
      },
    },
    players: {
      get: (steam, create) => m.players.getPlayer(steam, create),
      create: (steam, name) => m.players.createPlayer(steam, name ?? null),
      getAll: () => m.players.getAllPlayers(),
      getMembers: (gangId) => m.players.getMembers(gangId),
      findInGang: (gangId, query) => m.players.findPlayerInGang(gangId, query),
      async getMembership(steam): Promise<Membership | null> {
        const player = await m.players.getPlayer(steam, false);
        if (!player || player.gangId === null || player.gangRank === null) return null;
        const gang = await m.gangs.getGang(player.gangId);
        const rank = await m.ranks.getRank(player.gangId, player.gangRank);
        if (!gang || !rank) return null;
        return { player, gang, rank };
      },
      update: (p) => m.players.updatePlayer(p),
      delete: (steam) => m.players.deletePlayer(steam),
    },
    members: {
      async add(gangId, steam, rank) {
        const p = await m.players.getPlayer(steam);
        if (!p) return false;
        const ok = await m.players.updatePlayer({ ...p, gangId, gangRank: rank });
        if (ok) emit("member_joined", { gangId, steam, rank });
        return ok;
      },
      async remove(steam, reason) {
        const p = await m.players.getPlayer(steam, false);
        if (!p || p.gangId === null) return false;
        const gangId = p.gangId;
        const ok = await m.players.updatePlayer({ ...p, gangId: null, gangRank: null });
        if (ok) emit("member_left", { gangId, steam, reason });
        return ok;
      },
      async setRank(steam, newRank) {
        const p = await m.players.getPlayer(steam, false);
        if (!p || p.gangId === null || p.gangRank === null) return false;
        const oldRank = p.gangRank;
        if (oldRank === newRank) return true;
        const ok = await m.players.updatePlayer({ ...p, gangRank: newRank });
        if (ok) emit("member_rank_changed", { gangId: p.gangId, steam, oldRank, newRank });
        return ok;
      },
    },
    invites: {
      async create(gangId, inviter, invited, nowSec) {
        const data = (await m.stats.getForGang<InvitationData>(gangId, INVITATION)) ?? emptyInvitation();
        await m.stats.setForGang(gangId, INVITATION, addInvitation(data, inviter, invited, nowSec));
        const pend = (await m.stats.getForPlayer<PendingInvitationData>(invited, PENDING)) ?? { InvitingGangs: "" };
        await m.stats.setForPlayer(invited, PENDING, addPending(pend, gangId));
        emit("invite_created", { gangId, inviter, invited });
        return true;
      },
      async revoke(gangId, invited) {
        const data = await m.stats.getForGang<InvitationData>(gangId, INVITATION);
        if (data) await m.stats.setForGang(gangId, INVITATION, removeInvitation(data, invited));
        const pend = await m.stats.getForPlayer<PendingInvitationData>(invited, PENDING);
        if (pend) await m.stats.setForPlayer(invited, PENDING, removePending(pend, gangId));
        emit("invite_revoked", { gangId, invited });
        return true;
      },
      async outgoing(gangId) {
        const data = await m.stats.getForGang<InvitationData>(gangId, INVITATION);
        return data ? invitedList(data) : [];
      },
      async pending(steam) {
        const pend = await m.stats.getForPlayer<PendingInvitationData>(steam, PENDING);
        return pend ? pendingList(pend) : [];
      },
    },
    ranks: {
      getAll: (gangId) => m.ranks.getRanks(gangId),
      get: (gangId, rank) => m.ranks.getRank(gangId, rank),
      create: (gangId, name, rank, permissions) => m.ranks.createRank(gangId, name, rank, permissions),
      update: (gangId, rank) => m.ranks.updateRank(gangId, rank),
      delete: (gangId, rank, strat) => m.ranks.deleteRank(gangId, rank, strat),
      assignDefaults: (gangId) => m.ranks.assignDefaultRanks(gangId),
      async checkPermission(steam, perm) {
        const player = await m.players.getPlayer(steam, false);
        if (!player) return false;
        return (await m.ranks.checkRank(player, perm)).ok;
      },
      getJoinRank: (gangId) => m.ranks.getJoinRank(gangId),
      getRankNeeded: (gangId, perm) => m.ranks.getRankNeeded(gangId, perm),
    },
    stats: {
      register: (d) => m.stats.register(d),
      getForGang: (gangId, statId) => m.stats.getForGang(gangId, statId),
      setForGang: (gangId, statId, value) => m.stats.setForGang(gangId, statId, value),
      removeFromGang: (gangId, statId) => m.stats.removeFromGang(gangId, statId),
      getForPlayer: (steam, statId) => m.stats.getForPlayer(steam, statId),
      setForPlayer: (steam, statId, value) => m.stats.setForPlayer(steam, statId, value),
      removeFromPlayer: (steam, statId) => m.stats.removeFromPlayer(steam, statId),
    },
    eco: {
      getBalance: (steam, excludeGangCredits) => eco.getBalance(steam, excludeGangCredits),
      getGangBalance: (gangId) => eco.getGangBalance(gangId),
      canAfford: (steam, cost, excludeGangCredits) => eco.canAfford(steam, cost, excludeGangCredits),
      tryPurchase: (steam, cost, opts) => eco.tryPurchase(steam, cost, opts?.excludeGangCredits ?? false),
      grantPlayer: (steam, amount, reason) => eco.grantPlayer(steam, amount, reason ?? null),
      grantGang: (gangId, amount, reason) => eco.grantGang(gangId, amount, reason ?? null),
    },
  };
}
