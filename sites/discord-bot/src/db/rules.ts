/**
 * The rules the database's triggers used to enforce around an insert, now stated where
 * the insert is made: a new task or event under an open parent, an event's steps, and the
 * quotas on tasks and reassignments, counted under the locks that make them hold when
 * writes arrive together. Every check runs in the transaction of the write it guards, in
 * the order the triggers ran them, so the lock order, and with it the deadlock profile,
 * is the same.
 */

import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { BotTx } from "./client.ts";
import { requireOpenEvent } from "./history.ts";
import { evaluate, raise } from "./internal.ts";
import {
  eventSteps,
  eventStepKind,
  managedChannels,
  taskReassignments,
  tasks,
} from "./schema.ts";

/** The most live tasks one event holds. */
export const MAX_TASKS_PER_EVENT = 100;
/** The most tasks plus reassignments one officer makes in a day. */
export const MAX_ACTIONS_PER_DAY = 50;

/** The quotas count rows other writers may be adding, which only read committed sees. */
async function requireReadCommitted(tx: BotTx): Promise<void> {
  const level = await evaluate(
    tx,
    sql<string>`current_setting('transaction_isolation')`,
  );
  if (level !== "read committed") {
    raise("0A000", "task quotas need read committed");
  }
}

/** Holds a lock until the transaction ends, so two writes counting the same rows take turns. */
async function lockKey(tx: BotTx, key: string): Promise<void> {
  await evaluate(
    tx,
    sql`pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`,
  );
}

const actorKey = (guildId: string, actorId: string): string =>
  `task-quota-actor:${guildId}:${actorId}`;

/** What an officer has made in the last day: tasks, and changes of person. */
async function actionsToday(
  tx: BotTx,
  guildId: string,
  actorId: string,
): Promise<number> {
  const day = sql`now() - interval '24 hours'`;
  const [made] = await tx
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.guildId, guildId),
        eq(tasks.createdBy, actorId),
        gt(tasks.createdAt, day),
      ),
    );
  const [moved] = await tx
    .select({ n: count() })
    .from(taskReassignments)
    .where(
      and(
        eq(taskReassignments.guildId, guildId),
        eq(taskReassignments.actorId, actorId),
        gt(taskReassignments.createdAt, day),
      ),
    );
  return (made?.n ?? 0) + (moved?.n ?? 0);
}

/**
 * Before a task is inserted: its event is open, then the event and the officer are
 * locked, then the event is under its limit and the officer under theirs.
 */
export async function admitTask(
  tx: BotTx,
  {
    eventId,
    guildId,
    actorId,
  }: { eventId: string; guildId: string; actorId: string },
): Promise<void> {
  await requireOpenEvent(tx, eventId, guildId);
  await requireReadCommitted(tx);
  await lockKey(tx, `task-quota-event:${eventId}`);
  await lockKey(tx, actorKey(guildId, actorId));
  const [held] = await tx
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.eventId, eventId), isNull(tasks.deletedAt)));
  if ((held?.n ?? 0) >= MAX_TASKS_PER_EVENT) {
    raise("CF429", "event task limit reached");
  }
  if ((await actionsToday(tx, guildId, actorId)) >= MAX_ACTIONS_PER_DAY) {
    raise("CF430", "officer task limit reached");
  }
}

/** Before a change of a task's person is recorded: the officer is locked and under their limit. */
export async function admitReassignment(
  tx: BotTx,
  { guildId, actorId }: { guildId: string; actorId: string },
): Promise<void> {
  await requireReadCommitted(tx);
  await lockKey(tx, actorKey(guildId, actorId));
  if ((await actionsToday(tx, guildId, actorId)) >= MAX_ACTIONS_PER_DAY) {
    raise("CF430", "officer task limit reached");
  }
}

/** Before an event is inserted: its channel has not been removed. */
export async function requireLiveChannel(
  tx: BotTx,
  guildId: string,
  channelId: string,
): Promise<void> {
  const [channel] = await tx
    .select({ status: managedChannels.status })
    .from(managedChannels)
    .where(
      and(
        eq(managedChannels.guildId, guildId),
        eq(managedChannels.channelId, channelId),
      ),
    )
    .for("share");
  if (channel?.status === "removed") {
    raise("CF410", "channel has been removed");
  }
}

/** After an event is inserted: one open step of every kind. */
export async function makeSteps(
  tx: BotTx,
  event: { id: string; guildId: string },
): Promise<void> {
  await tx
    .insert(eventSteps)
    .values(
      eventStepKind.enumValues.map((kind) => ({
        eventId: event.id,
        guildId: event.guildId,
        kind,
      })),
    )
    .onConflictDoNothing();
}
