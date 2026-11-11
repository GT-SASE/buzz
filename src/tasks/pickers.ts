/**
 * Autocomplete for the task and event options. A keystroke is one request, so these
 * read capped, indexed queries and never write or call Discord. A list here is only a
 * suggestion: whatever is finally submitted is loaded and authorized again.
 *
 * The bot shows rows by a short ID, so text that could be the start of one also finds
 * the row with that ID. Those matches come first, as they are the more exact.
 */

import type { AutocompleteChoice } from "../discord/outbound.ts";
import type { DbResult } from "../db/errors.ts";
import type { RowList } from "../db/result.ts";
import {
  searchOpenEvents,
  searchOpenEventsByIdPrefix,
} from "../db/task-events.ts";
import {
  searchLiveTasks,
  searchLiveTasksByIdPrefix,
  searchOpenTasks,
  searchOpenTasksByIdPrefix,
  searchOwnOpenTasks,
  searchOwnOpenTasksByIdPrefix,
} from "../db/tasks.ts";
import { isIdPrefix } from "../db/validate.ts";
import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import { normaliseEventName } from "../events/input.ts";
import type { AutocompleteScope } from "../lib/permissions.ts";
import type { RouteContext } from "../handlers/router.ts";
import { eventChoice, taskChoice } from "./shared.ts";

function merged<T extends { readonly id: string }>(
  byId: DbResult<RowList<T>> | undefined,
  byText: DbResult<RowList<T>>,
): T[] {
  const first = byId?.ok === true ? byId.value.rows : [];
  const rest = byText.ok ? byText.value.rows : [];
  const seen = new Set(first.map((row) => row.id));
  return [...first, ...rest.filter((row) => !seen.has(row.id))].slice(
    0,
    DISCORD_LIMITS.autocompleteChoices,
  );
}

/** Uses the scope, not the actor, so a member is limited to what the scope allows. */
export async function taskChoices(
  ctx: RouteContext,
  { guildId, assigneeId }: AutocompleteScope,
  term: string,
): Promise<readonly AutocompleteChoice[]> {
  const prefix = isIdPrefix(term) ? term : undefined;
  if (assigneeId === undefined) {
    const [byId, byText] = await Promise.all([
      prefix === undefined
        ? undefined
        : searchOpenTasksByIdPrefix(ctx.db, { guildId, prefix }),
      searchOpenTasks(ctx.db, { guildId, term }),
    ]);
    return merged(byId, byText).map(taskChoice);
  }
  const [byId, byText] = await Promise.all([
    prefix === undefined
      ? undefined
      : searchOwnOpenTasksByIdPrefix(ctx.db, { guildId, assigneeId, prefix }),
    searchOwnOpenTasks(ctx.db, { guildId, assigneeId, term }),
  ]);
  return merged(byId, byText).map(taskChoice);
}

/** For /task delete, where done tasks can be picked too. Only officers can reach it. */
export async function deletableTaskChoices(
  ctx: RouteContext,
  scope: AutocompleteScope,
  term: string,
): Promise<readonly AutocompleteChoice[]> {
  const { guildId, assigneeId } = scope;
  if (assigneeId !== undefined) {
    return taskChoices(ctx, scope, term);
  }
  const prefix = isIdPrefix(term) ? term : undefined;
  const [byId, byText] = await Promise.all([
    prefix === undefined
      ? undefined
      : searchLiveTasksByIdPrefix(ctx.db, { guildId, prefix }),
    searchLiveTasks(ctx.db, { guildId, term }),
  ]);
  return merged(byId, byText).map(taskChoice);
}

/** Names are tidied when an event is made, so what was first typed is tidied here too. */
export async function eventChoices(
  ctx: RouteContext,
  { guildId }: AutocompleteScope,
  term: string,
): Promise<readonly AutocompleteChoice[]> {
  const prefix = isIdPrefix(term) ? term : undefined;
  const name = normaliseEventName(term)?.name ?? term;
  const [byId, byText] = await Promise.all([
    prefix === undefined
      ? undefined
      : searchOpenEventsByIdPrefix(ctx.db, { guildId, prefix }),
    searchOpenEvents(ctx.db, { guildId, term: name }),
  ]);
  return merged(byId, byText).map(eventChoice);
}
