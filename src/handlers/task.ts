/** /task, whose subcommands each live in src/tasks. */

import { assignRoutes, assignSubcommand } from "../tasks/assign.ts";
import { deleteRoutes, deleteSubcommand } from "../tasks/delete.ts";
import { doneRoutes, doneSubcommand } from "../tasks/done.ts";
import { editRoutes, editSubcommand } from "../tasks/edit.ts";
import { refreshOverview } from "../events/overview.ts";
import type { TaskDependencies } from "../tasks/shared.ts";
import type { Handler } from "./router.ts";

/** Takes the overview refresh from outside, so tasks do not depend on how it's drawn. */
export function createTaskHandler(dependencies: TaskDependencies): Handler {
  return {
    commands: [
      {
        name: "task",
        description: "Assign and manage tasks on events",
        options: [
          assignSubcommand,
          editSubcommand,
          deleteSubcommand,
          doneSubcommand,
        ],
      },
    ],
    routes: [
      ...assignRoutes(dependencies),
      ...editRoutes(dependencies),
      ...deleteRoutes(dependencies),
      ...doneRoutes(dependencies),
    ],
  };
}

const LIVE_OVERVIEW: TaskDependencies = {
  refreshOverview: (event, ctx) => refreshOverview(ctx, event),
};

export const handler: Handler = createTaskHandler(LIVE_OVERVIEW);
