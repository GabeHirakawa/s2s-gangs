import { Menu } from "@s2script/sdk/menu";
import { Clients } from "@s2script/sdk/clients";
import type { GangsApi } from "../../api";
import type { Messages } from "../messages";
import type { CmdCtx, OnlinePlayer } from "../commands/ctx";
import { runCommand } from "../commands/handlers";
import { mainMenuModel, type MenuModel } from "./menu-model";
import { route, type RouterCtx } from "./menu-router";

/** Resolve currently-connected players matching a name substring or an exact SteamID. */
function onlineOf(query: string): OnlinePlayer[] {
  const q = query.toLowerCase();
  return Clients.all()
    .filter((c) => c.isValid() && !c.isBot)
    .map((c) => ({ steam: c.steamId, name: c.name }))
    .filter((o) => o.steam === query || o.name.toLowerCase().includes(q));
}

/** Build a CmdCtx bound to a slot, replying into that player's chat (used when the menu runs a command). */
function ctxForSlot(api: GangsApi, msg: Messages, slot: number, steam: string): CmdCtx {
  return {
    steam,
    args: [],
    reply: (m) => Clients.fromSlot(slot)?.chat(m),
    api,
    msg,
    online: onlineOf,
    nowSec: Math.floor(Date.now() / 1000),
  };
}

/** Display a model to a slot and wire selections through the router, re-displaying the next model. */
export function openMenu(api: GangsApi, getMsg: () => Messages, slot: number, steam: string, model: MenuModel): void {
  const menu = new Menu(model.title);
  for (const item of model.items) menu.addItem(item.info, item.label, { disabled: item.disabled });
  const rctx: RouterCtx = {
    api,
    viewerSteam: steam,
    run: (command, args) => runCommand(command, { ...ctxForSlot(api, getMsg(), slot, steam), args }),
  };
  menu.onSelect((e) => {
    void route(e.info, rctx)
      .then((next) => { if (next) openMenu(api, getMsg, slot, steam, next); })
      .catch((err) => {
        Clients.fromSlot(slot)?.chat("An error occurred.");
        console.log("[gangs] menu error:", err);
      });
  });
  menu.display(slot, 0);
}

/** Open the main gang menu for a connected player slot. */
export async function openGangMenu(api: GangsApi, getMsg: () => Messages, slot: number): Promise<void> {
  const client = Clients.fromSlot(slot);
  if (!client || client.steamId === "0") return;
  const model = await mainMenuModel(api, client.steamId);
  openMenu(api, getMsg, slot, client.steamId, model);
}
