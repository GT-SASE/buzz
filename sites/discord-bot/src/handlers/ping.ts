/** Checks that the endpoint answers. It needs no setup and no database. */

import { ephemeralReply } from "../discord/outbound.ts";
import { safe } from "../discord/safe-text.ts";
import { commandRoute, noRow, type Handler } from "./router.ts";

export const handler: Handler = {
  commands: [{ name: "ping", description: "Check that the bot is responding" }],
  routes: [
    commandRoute({
      path: "ping",
      gate: noRow("ping"),
      reply: () => ephemeralReply({ content: safe`Pong!`, mentionUserIds: [] }),
    }),
  ],
};
