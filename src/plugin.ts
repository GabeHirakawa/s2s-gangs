import { plugin } from "@s2script/sdk/plugin";
import { Chat } from "@s2script/sdk/chat";

export default plugin((ctx) => {
  ctx.commands.register("hello", (cmd) => {
    cmd.reply("hello from s2script");
    if (cmd.callerSlot >= 0) {
      Chat.toSlot(cmd.callerSlot, "hello from s2script");
    }
  });
});
