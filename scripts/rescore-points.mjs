/**
 * Re-scores every past check-in under the current points rules (see
 * packages/api/src/check-in-points.ts) by replaying them in order through the
 * same scoring function the door uses. Dry run by default.
 *
 *   DATABASE_URL=postgres://... pnpm points:rescore
 *   DATABASE_URL=postgres://... pnpm points:rescore --officer a@b.com [--apply]
 *
 * PowerShell (the variable stays set for the whole session, so clear it):
 *   $env:DATABASE_URL = "postgres://..."; pnpm points:rescore --officer a@b.com [--apply]; Remove-Item Env:DATABASE_URL
 * Pass flags without a `--` separator: `pnpm points:rescore -- --apply` errors
 * with "Unknown argument: --".
 *
 * --officer <email>  Repeatable. Promotes that user MEMBER -> ADMIN (with
 *                    --apply) and scores them as an officer. A SUPER_ADMIN is
 *                    never touched; an unknown email is an error.
 * --apply            Writes the role changes and every changed pointsEarned in
 *                    ONE transaction. It takes an EXCLUSIVE lock on events, so
 *                    it waits for in-flight check-ins and holds new ones at the
 *                    door until it commits; run it when no event is open.
 *                    Without it nothing is written.
 *
 * Every row is re-priced at its event's CURRENT pointsValue. An event that was
 * re-priced after people attended moves their history to the new value.
 *
 * DATABASE_URL is read from the shell environment only. No .env file is
 * loaded, so a stray file can never point this at the wrong database. Running
 * it twice is safe: scores come from the rules, not from the old points, so a
 * second run after --apply reports 0 changes.
 */
import { createRequire } from "node:module";

import { rescorePoints } from "../packages/api/src/rescore-points";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set. Pass it in the shell; no .env file is read.",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const officerEmails = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--officer") {
    const value = args[(i += 1)];
    if (!value) {
      console.error("--officer needs an email.");
      process.exit(1);
    }
    officerEmails.push(value.trim().toLowerCase());
  } else if (arg.startsWith("--officer=")) {
    officerEmails.push(arg.slice("--officer=".length).trim().toLowerCase());
  } else if (arg !== "--apply") {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

{
  let target;
  try {
    target = new URL(url);
  } catch {
    console.error(
      "DATABASE_URL is not a valid postgres:// URL (value not shown).",
    );
    process.exit(1);
  }
  target.password = "";
  console.log(
    `Target: ${target.protocol}//${target.username ? `${target.username}@` : ""}${target.host}${target.pathname}`,
  );
  console.log(apply ? "Mode: APPLY" : "Mode: dry run (nothing is written)");
}

// pg lives in packages/db, not at the repo root.
const require = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { Client } = require("pg");

const client = new Client({ connectionString: url });
await client.connect();

let failed = false;
try {
  await client.query("BEGIN");
  if (apply) {
    // Every check-in/remove path locks its event row FOR UPDATE before reading
    // totals. EXCLUSIVE waits for in-flight ones and holds new ones at the door
    // until COMMIT; plain SELECTs still run. lock_timeout keeps a stuck wait
    // from queueing every scanner behind the script (the catch rolls back).
    // Lock order (event, then check-in) matches the live paths: no deadlock.
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("LOCK TABLE buzz_event IN EXCLUSIVE MODE");
    await client.query(
      "LOCK TABLE buzz_event_check_in IN SHARE ROW EXCLUSIVE MODE",
    );
  }

  const users = (
    await client.query("SELECT id, name, email, role FROM buzz_user")
  ).rows;
  const events = (
    await client.query(
      'SELECT id, "startsAt", "pointsValue", "archivedAt" FROM buzz_event',
    )
  ).rows;
  const checkIns = (
    await client.query(
      'SELECT id, "eventId", "userId", "checkedInAt", "pointsEarned", method FROM buzz_event_check_in',
    )
  ).rows;

  const roles = new Map(users.map((user) => [user.id, user.role]));
  const promotions = [];
  for (const email of officerEmails) {
    const user = users.find((u) => u.email.toLowerCase() === email);
    if (!user) throw new Error(`No user with email ${email}.`);
    if (user.role === "MEMBER") {
      promotions.push(user);
      roles.set(user.id, "ADMIN");
    } else {
      console.log(`${email} is already ${user.role}; role left alone.`);
    }
  }

  const result = rescorePoints({ events, checkIns, roles });
  const changed = result.rows.filter((row) => row.oldPoints !== row.newPoints);
  const userById = new Map(users.map((user) => [user.id, user]));

  const lines = result.users.map((entry) => {
    const user = userById.get(entry.userId);
    const promoted = promotions.some((p) => p.id === entry.userId);
    const delta = entry.newTotal - entry.oldTotal;
    return [
      user?.name
        ? `${user.name} <${user.email}>`
        : (user?.email ?? entry.userId),
      promoted ? "ADMIN*" : (roles.get(entry.userId) ?? "MEMBER"),
      String(entry.oldTotal),
      String(entry.newTotal),
      delta > 0 ? `+${delta}` : String(delta),
      String(entry.oldRank),
      String(entry.newRank),
    ];
  });
  const header = ["member", "role", "old", "new", "delta", "old#", "new#"];
  const widths = header.map((h, col) =>
    Math.max(h.length, ...lines.map((line) => line[col].length)),
  );
  const fmt = (cells) =>
    cells
      .map((cell, col) =>
        col === 0 || col === 1
          ? cell.padEnd(widths[col])
          : cell.padStart(widths[col]),
      )
      .join("  ");
  console.log("");
  console.log(fmt(header));
  for (const line of lines) console.log(fmt(line));
  console.log("");
  console.log(
    `${changed.length} of ${result.rows.length} check-ins change; ${promotions.length} role change(s)${promotions.length ? " (* = promoted to ADMIN)" : ""}.`,
  );

  if (apply) {
    for (const user of promotions) {
      await client.query(
        "UPDATE buzz_user SET role = 'ADMIN' WHERE id = $1 AND role = 'MEMBER'",
        [user.id],
      );
    }
    const BATCH = 500;
    for (let i = 0; i < changed.length; i += BATCH) {
      const chunk = changed.slice(i, i + BATCH);
      await client.query(
        `UPDATE buzz_event_check_in AS c SET "pointsEarned" = v.points
         FROM unnest($1::text[], $2::int[]) AS v(id, points)
         WHERE c.id = v.id`,
        [chunk.map((row) => row.id), chunk.map((row) => row.newPoints)],
      );
    }
    await client.query("COMMIT");
    console.log("Applied.");
  } else {
    await client.query("ROLLBACK");
    console.log("Dry run only. Re-run with --apply to write.");
  }
} catch (error) {
  failed = true;
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
} finally {
  await client.end();
}
if (failed) process.exit(1);
