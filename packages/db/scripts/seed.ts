/**
 * Fills a local database with enough to walk both portal flows.
 *
 * Codes are fixed rather than random so they can be typed from these notes; the
 * alphabet is the same one the app generates from, which excludes I, L, O, U, 0
 * and 1. Re-running is safe: every insert is keyed on something already unique.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../src/schema.ts";

const envFile = resolve(import.meta.dirname, "../../../sites/web/.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(`DATABASE_URL is not set. Add it to ${envFile} first.`);
}

{
  const host = new URL(url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local && process.env.SEED_FORCE !== "1") {
    throw new Error(
      `Refusing to seed non-local database host "${host}". Set SEED_FORCE=1 to override.`,
    );
  }
}

const sql = postgres(url);
const db = drizzle(sql, { schema });

const OFFICER = "officer@dev.local";
const day = 24 * 60 * 60 * 1000;

async function main() {
  let officer = await db.query.users.findFirst({
    where: eq(schema.users.email, OFFICER),
  });

  if (!officer) {
    const [created] = await db
      .insert(schema.users)
      .values({ email: OFFICER, name: "Dev Officer", role: "ADMIN" })
      .returning();
    officer = created;
    console.log("created the officer account");
  }

  if (!officer) throw new Error("could not create the officer account");

  const now = Date.now();
  const events = [
    {
      title: "Fall Kickoff and General Body Meeting",
      description:
        "Meet the board, hear what the chapter is running this year, and eat.",
      location: "Klaus 1443",
      startsAt: new Date(now + 2 * day),
      pointsValue: 15,
      checkInCode: "SASEGT26",
      maxCheckIns: null,
    },
    {
      title: "Resume Workshop with Corporate Partners",
      description: "Line-by-line edits from recruiters and alumni.",
      location: "Scheller College of Business",
      startsAt: new Date(now + 9 * day),
      pointsValue: 20,
      checkInCode: "WKSHP789",
      maxCheckIns: 40,
    },
    {
      title: "Taste of SASE",
      description: "The cultural food festival on Tech Green.",
      location: "Tech Green",
      // Yesterday, so the closed-door and past-event states are visible too.
      startsAt: new Date(now - 1 * day),
      pointsValue: 10,
      checkInCode: "TASTE234",
      maxCheckIns: null,
    },
  ];

  for (const event of events) {
    const existing = await db.query.events.findFirst({
      where: eq(schema.events.checkInCode, event.checkInCode),
    });
    if (existing) {
      console.log(`already there: ${event.title}`);
      continue;
    }
    await db
      .insert(schema.events)
      .values({ ...event, createdById: officer.id });
    console.log(`created: ${event.title}  code ${event.checkInCode}`);
  }

  console.log("\nSign in at /portal/signin and use one of these codes.");
}

await main();
await sql.end();
