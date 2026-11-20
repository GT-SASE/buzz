/**
 * Everything the bot answers: the router the endpoint uses, and the commands that
 * scripts/register-commands.ts sends to Discord. To add a handler, add its line to
 * modules.ts. Nothing here changes.
 */

import type { RESTPutAPIApplicationGuildCommandsJSONBody } from "discord-api-types/v10";
import * as modules from "./modules.ts";
import { createRouter } from "./router.ts";

const HANDLERS = Object.values(modules).map((module) => module.handler);

export const ROUTER = createRouter(HANDLERS);

export const COMMANDS = HANDLERS.flatMap(
  (handler) => handler.commands,
) as RESTPutAPIApplicationGuildCommandsJSONBody;
