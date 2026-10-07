import type { Gangs } from "../service/gangs";
import type { Messages } from "../messages";
import { Perm } from "../domain/perm";
import { parseGangChat } from "./gang-chat-parse";

export { parseGangChat };

export interface GangChatDelivery { line: string; recipients: string[]; }

/**
 * Resolve a say-text into a gang-chat delivery, synchronously from the cache.
 *
 * Returns null — the message falls through as normal public chat — unless the text is a `.message`
 * from a gang member whose gang owns the Gang Chat perk and whose rank holds SEND_GANG_CHAT.
 * Recipients are the gang's members that are currently online.
 */
export function resolveGangChat(g: Gangs, msg: Messages, steam: string, text: string): GangChatDelivery | null {
  const message = parseGangChat(text);
  if (message === null) return null;
  const p = g.svc.getPlayer(steam);
  if (!p || p.gangId === null) return null;
  const gang = g.svc.getGang(p.gangId);
  if (!gang || !g.perks.hasGangChat(gang.gangId) || !g.svc.hasPermission(steam, Perm.SEND_GANG_CHAT)) return null;
  const recipients = g.svc.membersOf(gang.gangId).map((m) => m.steam).filter((s) => g.svc.isOnline(s));
  return { line: msg.gangChat(gang.name, p.name ?? steam, message), recipients };
}
