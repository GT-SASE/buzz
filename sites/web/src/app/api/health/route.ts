import { sql } from "drizzle-orm";

import { db } from "@buzz/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const startedAt = Date.now();

  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health.database",
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    return Response.json(
      { status: "degraded", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { status: "ok", database: "ok", latencyMs: Date.now() - startedAt },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
