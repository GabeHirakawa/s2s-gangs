import { Menu } from "@s2script/sdk/menu";
import { Clients } from "@s2script/sdk/clients";
import type { Gangs } from "../service/gangs";
import type { Messages } from "../messages";
import type { CmdCtx, OnlinePlayer } from "../commands/ctx";
import { runCommand } from "../commands/handlers";
import { mainMenuModel, type MenuModel } from "./menu-model";
import { route, type RouterCtx } from "./menu-router";

/** The connected client in `slot` if it is still `steam` (a slot is not a stable identity). */
function clientFor(slot: number, steam: string) {
  const c = Clients.fromSlot(slot);
  return c && c.isValid() && c.steamId === steam ? c : null;
}

/** Display a model to a slot and wire selections through the router, re-displaying the next model. */
export function openMenu(
  gangs: Gangs, getMsg: () => Messages, online: (q: string) => OnlinePlayer[],
  slot: number, steam: string, model: MenuModel,
): void {
  const menu = new Menu(model.title);
  for (const item of model.items) menu.addItem(item.info, item.label, item.disabled ? { disabled: true } : undefined);
  const ctxFor = (args: string[]): CmdCtx => ({
    steam, args, gangs, msg: getMsg(), online, nowSec: Math.floor(Date.now() / 1000),
    reply: (m) => clientFor(slot, steam)?.chat(m),
  });
  const rctx: RouterCtx = {
    gangs,
    viewerSteam: steam,
    run: (command, args) => runCommand(command, ctxFor(args)),
    runAsPlayer: (command) => {
      const c = clientFor(slot, steam);
      if (c && !c.fakeCommand(command)) c.chat(getMsg().usage(`!${command.replace(/^sm_/, "")}`));
    },
  };
  menu.onSelect((e) => {
    if (!clientFor(slot, steam)) return;
    try {
      const next = route(e.info, rctx);
      if (next) openMenu(gangs, getMsg, online, slot, steam, next);
    } catch (err) {
      clientFor(slot, steam)?.chat("An error occurred.");
      console.log(`[gangs] menu error: ${String(err)}`);
    }
  });
  menu.display(slot, 0);
}

/** Open the main gang menu for a connected player slot. */
export function openGangMenu(gangs: Gangs, getMsg: () => Messages, online: (q: string) => OnlinePlayer[], slot: number): boolean {
  const client = Clients.fromSlot(slot);
  if (!client || client.steamId === "0" || !gangs.svc.isLoaded(client.steamId)) return false;
  openMenu(gangs, getMsg, online, slot, client.steamId, mainMenuModel(gangs, client.steamId));
  return true;
}
