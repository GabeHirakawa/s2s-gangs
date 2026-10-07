import type { GangsApi } from "../../api";
import { GangService, type ServiceOptions } from "./gang-service";
import { Economy } from "../eco/economy";
import { PerkCatalog } from "../perks/catalog";
import { buildGangsApi } from "../api/impl";
import type { Messages } from "../messages";

/** The SDK-free composition root: service + economy + perks + the published api object. */
export interface Gangs {
  svc: GangService;
  eco: Economy;
  perks: PerkCatalog;
  api: GangsApi;
}

export interface GangsOptions extends ServiceOptions {
  /** Is the plugin with this id running? Gates external perk visibility. Default: always. */
  providerRunning?: (provider: string) => boolean;
  /** Deliver a line to the online members (SteamIDs) of a gang. Default: no-op. */
  deliver?: (steamIds: string[], line: string) => void;
  /** Current messages (re-read per call so a live chat_tag reload applies). */
  messages: () => Messages;
}

export function createGangs(opts: GangsOptions): Gangs {
  const svc = new GangService(opts);
  const eco = new Economy(svc);
  const perks = new PerkCatalog(svc, eco, opts.providerRunning);
  const deliver = opts.deliver ?? (() => {});
  const api = buildGangsApi({
    svc, eco, perks,
    sendGangChat(gangId, message) {
      const gang = svc.getGang(gangId);
      if (!gang) return;
      const online = svc.membersOf(gangId).map((m) => m.steam).filter((s) => svc.isOnline(s));
      if (online.length) deliver(online, opts.messages().gangNotice(gang.name, message));
    },
  });
  return { svc, eco, perks, api };
}
