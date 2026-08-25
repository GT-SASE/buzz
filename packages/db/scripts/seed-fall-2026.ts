/**
 * Publishes the fall 2026 chapter calendar into the events table the public
 * site and the portal already share.
 *
 * Re-running is safe: each row is keyed on title + start. A second pass
 * updates copy, room, points, and check-in without rotating the code.
 *
 * Remote databases need SEED_FORCE=1. This script will not invent an officer
 * account — it attaches new rows to an existing ADMIN user.
 *
 * Left out on purpose: Sat Oct 24 social/volunteering and Tue Oct 27 Halloween
 * still look tentative.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../src/schema.ts";

const envFile = resolve(import.meta.dirname, "../../../.env");
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

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

function newCheckInCode() {
  const alphabetLen = CODE_ALPHABET.length;
  const rejectAbove = 256 - (256 % alphabetLen);
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH - code.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= rejectAbove) continue;
      code += CODE_ALPHABET[byte % alphabetLen];
      if (code.length >= CODE_LENGTH) break;
    }
  }
  return code;
}

function isUniqueViolation(error: unknown) {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth++) {
    if (typeof cursor !== "object") break;
    if ((cursor as { code?: string }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

type Draft = {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  pointsValue: number;
  checkInEnabled: boolean;
};

const fall2026: Draft[] = [
  {
    title: "Fall Org Fair",
    description: "Chapter table on Tech Green, Sep 1–2.",
    location: "Tech Green",
    startsAt: new Date("2026-09-01T11:00:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "September Drawing Challenge GBM",
    description:
      "First general body meeting of the year. Free dinner and a blind / deaf / mute drawing challenge. RSVP on Engage.",
    location: "Skiles 271",
    startsAt: new Date("2026-09-02T18:00:00-04:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "SASE × IBM — resume and job apps with AI",
    description:
      "With Vivian Tan. Food provided. Coffee chats the next day in the same room. RSVP on Engage.",
    location: "Van Leer C456",
    startsAt: new Date("2026-09-08T18:30:00-04:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "IBM coffee chats",
    description: "Follow-up from the IBM session the night before.",
    location: "Van Leer C456",
    startsAt: new Date("2026-09-09T18:30:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "SASE × Donaldson speaker event",
    description: "Food provided. RSVP on Engage.",
    location: "Van Leer C457",
    startsAt: new Date("2026-09-10T18:30:00-04:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "SASE KIN interest meeting",
    description: "Food provided. RSVP on Engage.",
    location: "Klaus 2456",
    startsAt: new Date("2026-09-14T18:30:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "Campus career fairs",
    description:
      "Sep 14–18: All Majors, ME/MSE, CoC/BME, and ECE. SASE is not the host.",
    location: "Georgia Tech campus",
    startsAt: new Date("2026-09-14T09:00:00-04:00"),
    pointsValue: 0,
    checkInEnabled: false,
  },
  {
    title: "Mid-Autumn Festival",
    description: null,
    location: null,
    startsAt: new Date("2026-09-22T18:30:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "National Conference info session",
    description: "For members already attending NC.",
    location: "IC 211",
    startsAt: new Date("2026-09-28T18:30:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "STEM Connect / NatCon",
    description: "SASE national conference. Oct 1–3 in Seattle.",
    location: "Seattle",
    startsAt: new Date("2026-10-01T09:00:00-04:00"),
    pointsValue: 25,
    checkInEnabled: true,
  },
  {
    title: "October GBM",
    description: null,
    location: "IC 215",
    startsAt: new Date("2026-10-12T18:00:00-04:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "GTRI speaker session",
    description: null,
    location: "Van Leer C456",
    startsAt: new Date("2026-10-14T18:30:00-04:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "Hacktoberfest",
    description: "Saturday workshop.",
    location: "IC 103",
    startsAt: new Date("2026-10-17T10:00:00-04:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "Vibecoding a personal website",
    description: null,
    location: "Van Leer C456",
    startsAt: new Date("2026-10-20T18:00:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "SASE KIN October",
    description: null,
    location: "College of Computing 102",
    startsAt: new Date("2026-10-26T18:30:00-04:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "Movie night",
    description: null,
    location: "Klaus 1456",
    startsAt: new Date("2026-11-06T18:00:00-05:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "November GBM / Diwali",
    description: null,
    location: "Skiles 268",
    startsAt: new Date("2026-11-10T18:30:00-05:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
  {
    title: "SASE KIN November",
    description: null,
    location: "College of Computing 102",
    startsAt: new Date("2026-11-16T18:30:00-05:00"),
    pointsValue: 10,
    checkInEnabled: true,
  },
  {
    title: "December GBM + exam destress",
    description: null,
    location: "IC 111",
    startsAt: new Date("2026-12-08T18:00:00-05:00"),
    pointsValue: 15,
    checkInEnabled: true,
  },
];

async function main() {
  const officer = await db.query.users.findFirst({
    where: eq(schema.users.role, "ADMIN"),
  });
  if (!officer) {
    throw new Error(
      "No ADMIN user in this database. Sign in with an allowlisted officer first.",
    );
  }

  for (const event of fall2026) {
    const existing = await db.query.events.findFirst({
      where: and(
        eq(schema.events.title, event.title),
        eq(schema.events.startsAt, event.startsAt),
      ),
    });
    if (existing) {
      await db
        .update(schema.events)
        .set({
          description: event.description,
          location: event.location,
          pointsValue: event.pointsValue,
          checkInEnabled: event.checkInEnabled,
        })
        .where(eq(schema.events.id, existing.id));
      console.log(`updated: ${event.title}`);
      continue;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.insert(schema.events).values({
          title: event.title,
          description: event.description,
          location: event.location,
          startsAt: event.startsAt,
          pointsValue: event.pointsValue,
          checkInEnabled: event.checkInEnabled,
          checkInCode: newCheckInCode(),
          createdById: officer.id,
        });
        console.log(`created: ${event.title}`);
        break;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error;
      }
    }
  }
}

await main();
await sql.end();
