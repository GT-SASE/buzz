import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The check has to grow, and nothing else. Assigning SUPER_ADMIN is a manual
 * step after merge — a migration that also rewrote rows would promote the
 * wrong people.
 */
describe("super admin migration", () => {
  const sql = readFileSync(
    new URL(
      "../packages/db/drizzle/0008_super_admin_role.sql",
      import.meta.url,
    ),
    "utf8",
  );

  it("allows SUPER_ADMIN on buzz_user_role_check", () => {
    expect(sql).toContain(
      `CHECK ("buzz_user"."role" in ('MEMBER', 'ADMIN', 'SUPER_ADMIN'))`,
    );
  });

  it("does not update any row", () => {
    expect(sql.toLowerCase()).not.toMatch(/\bupdate\b/);
    expect(sql.toLowerCase()).not.toMatch(/\binsert\b/);
    expect(sql.toLowerCase()).not.toMatch(/\bdelete\b/);
  });
});
