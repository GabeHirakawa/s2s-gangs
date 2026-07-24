import { plugin } from "@s2script/sdk/plugin";
import { Database } from "@s2script/sdk/db";
import { config } from "@s2script/sdk/config";
import { ADMFLAG } from "@s2script/sdk/admin";
import type { GangsApi } from "../api";
import { ensureCoreTables } from "./db/schema";
import { GangsRepo } from "./db/gangs.repo";
import { PlayersRepo } from "./db/players.repo";
import { RanksRepo } from "./db/ranks.repo";
import { StatStore } from "./db/instance.repo";
import { PlayerManager } from "./managers/player-manager";
import { RankManager } from "./managers/rank-manager";
import { GangManager } from "./managers/gang-manager";
import { StatManager } from "./managers/stat-manager";
import { buildGangsApi } from "./api/impl";
import type { EmitFn, GangEvents } from "./api/events";
import { makeMessages } from "./messages";
import { registerGangCommands, registerMenuCommand, runCreditsCommand } from "./commands/gang";
import { INVITATION_STAT, PENDING_STAT, DOOR_POLICY_STAT } from "./commands/handlers";
import { GANG_BALANCE_STAT, PLAYER_BALANCE_STAT } from "./eco/balance";
import { registerGangChat } from "./perks/gang-chat";

export default plugin(async (ctx) => {
  const prefix = config.getString("table_prefix") || "gang";
  const connName = config.getString("db_connection") || "default";
  const tag = config.getString("chat_tag") || "Gangs>";

  const db = await Database.open(connName); // real Database; structurally satisfies the repos' `Db`
  await ensureCoreTables(db, prefix);

  const players = new PlayerManager(new PlayersRepo(db, prefix));
  const ranks = new RankManager(new RanksRepo(db, prefix), players);
  const gangs = new GangManager(new GangsRepo(db, prefix), players, ranks);
  const stats = new StatManager(
    new StatStore(db, `${prefix}_gang_stats`, "GangId", "INTEGER"),
    new StatStore(db, `${prefix}_player_stats`, "Steam", "BIGINT"),
  );

  // publish/emit are wired via a forwarder so the API can emit through the handle it helps create.
  let handle: { emit(event: string, payload: unknown): void } | null = null;
  const emit: EmitFn = <K extends keyof GangEvents>(event: K, payload: GangEvents[K]) =>
    handle?.emit(event, payload);

  const api: GangsApi = buildGangsApi({ gangs, players, ranks, stats }, emit);
  api.stats.register(INVITATION_STAT);
  api.stats.register(PENDING_STAT);
  api.stats.register(DOOR_POLICY_STAT);
  api.stats.register(GANG_BALANCE_STAT);
  api.stats.register(PLAYER_BALANCE_STAT);

  handle = ctx.publish<GangsApi>("@gangs/api", api);

  let msg = makeMessages(tag);
  registerGangCommands(ctx.commands, api, () => msg);
  registerMenuCommand(ctx.commands, api, () => msg);
  ctx.commands.registerAdmin("sm_credits", ADMFLAG.ROOT, (cmd) => runCreditsCommand(api, cmd));
  registerGangChat(ctx, api, () => msg);

  // Live-reload the chat tag (design §7); the command closure reads `msg` by reference.
  ctx.config.onChange(() => { msg = makeMessages(config.getString("chat_tag") || "Gangs>"); });

  return { onUnload: () => { void db.close(); } };
});
