import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

/**
 * The reset has to be derived from each event's configured points, and the
 * non-negative check has to come back. A migration that hardcodes one person's
 * total would miss every other joke row. points_earned_integer resets before the cast
 * so negative rows do not abort the deploy. restore_check_in_points repeats
 * the reset for a database that already applied an earlier
 * points_earned_integer that only changed the type.
 */
describe("restore check-in points migration", () => {
  const typeMigration = readFileSync(
    new URL(
      "../packages/db/drizzle/20261015212913_points_earned_integer/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const resetMigration = readFileSync(
    new URL(
      "../packages/db/drizzle/20261015225640_restore_check_in_points/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );

  it("sets pointsEarned from the event's pointsValue before narrowing the column", () => {
    for (const sql of [typeMigration, resetMigration]) {
      expect(sql).toContain('SET "pointsEarned" = event."pointsValue"');
      expect(sql).toContain('FROM "buzz_event" AS event');
      expect(sql).toContain('check_in."eventId" = event.id');
      expect(sql).toContain(
        'ADD CONSTRAINT "buzz_check_in_points_earned_check"',
      );
      expect(sql).toContain(
        'CHECK ("buzz_event_check_in"."pointsEarned" >= 0)',
      );
    }
    const updateAt = typeMigration.indexOf('SET "pointsEarned"');
    const castAt = typeMigration.indexOf("SET DATA TYPE integer");
    expect(updateAt).toBeGreaterThan(-1);
    expect(castAt).toBeGreaterThan(updateAt);
  });
});
