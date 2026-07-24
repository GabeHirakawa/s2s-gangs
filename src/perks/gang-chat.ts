import { Clients } from "@s2script/sdk/clients";
import { HookResult } from "@s2script/sdk/events";
import type { PluginContext } from "@s2script/sdk/plugin";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import { Perm, hasPerm } from "../domain/perm";
import { parseGangChat } from "./gang-chat-parse";

export { parseGangChat };

/**
 * Hook say-text: a member with the Gang Chat perk + SEND_GANG_CHAT typing ".msg" messages online gang members.
 *
 * Eligibility (membership, perk-owned, SEND_GANG_CHAT) can only be resolved asynchronously (DB-backed),
 * while `onSay` must answer synchronously whether to suppress the client's own chat line. We therefore
 * suppress every syntactically-valid ".msg" from a real client up front and resolve/broadcast async: an
 * ineligible sender's "." message is swallowed rather than falling through to public chat (see the
 * design doc's amended error-handling note) — the alternative (a synchronous eligibility cache) would
 * need to be kept correct across membership/perk/rank changes elsewhere in the plugin, which is out of
 * scope for this runtime hook.
 */
export function registerGangChat(ctx: PluginContext, api: GangsApi, getMsg: () => Messages): void {
  ctx.clients.onSay((slot, text) => {
    const message = parseGangChat(text);
    if (message === null) return HookResult.Continue;
    const caller = Clients.fromSlot(slot);
    if (!caller || caller.steamId === "0") return HookResult.Continue;
    const steam = caller.steamId;
    // fire-and-forget; suppress the public broadcast immediately since it starts with '.'
    void (async () => {
      const membership = await api.players.getMembership(steam);
      if (!membership) return;
      const enabled = (await api.stats.getForGang<number>(membership.gang.gangId, "gang_native_chat")) === 1;
      if (!enabled || !hasPerm(membership.rank.permissions, Perm.SEND_GANG_CHAT)) return;
      const line = getMsg().gangChat(membership.gang.name, membership.player.name ?? steam, message);
      const members = await api.players.getMembers(membership.gang.gangId);
      const onlineSteams = new Set(members.map((m) => m.steam));
      for (const c of Clients.all()) if (c.isValid() && onlineSteams.has(c.steamId)) c.chat(line);
    })();
    return HookResult.Handled; // don't echo ".msg" to public chat
  });
}
