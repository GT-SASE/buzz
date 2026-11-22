import {
  auditLog,
  pointsLedger,
  type AuditAction,
  type AuditTargetType,
  type db as appDb,
  type PointsSource,
} from "@buzz/db";

/**
 * All the writers need of a database handle: the pool for a read-only action
 * (an export), or the transaction of the change being recorded. Always pass
 * the transaction when there is one, so the row and the change commit or roll
 * back together.
 */
type Writer = Pick<typeof appDb, "insert">;

export type AuditEntry = {
  actorId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | null;
  /** What the target was called now: an email, an event title. Kept as text so it survives a rename or a deletion. */
  targetLabel?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/** Longest text a column holds. Longer is cut, never refused: a log must not fail the action it records. */
const LABEL_MAX = 255;

function clip(value: string | null | undefined) {
  return value == null ? null : value.slice(0, LABEL_MAX);
}

export async function recordAudit(db: Writer, entry: AuditEntry) {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: clip(entry.targetId),
    targetLabel: clip(entry.targetLabel),
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export type PointsEntry = {
  userId: string;
  delta: number;
  reason: string;
  source: PointsSource;
  eventId?: string | null;
  actedByUserId?: string | null;
};

/** One signed row per entry, in one statement. An empty list writes nothing. */
export async function recordPoints(db: Writer, entries: PointsEntry[]) {
  if (entries.length === 0) return;
  await db.insert(pointsLedger).values(
    entries.map((entry) => ({
      userId: entry.userId,
      delta: entry.delta,
      reason: clip(entry.reason)!,
      source: entry.source,
      eventId: entry.eventId ?? null,
      actedByUserId: entry.actedByUserId ?? null,
    })),
  );
}
