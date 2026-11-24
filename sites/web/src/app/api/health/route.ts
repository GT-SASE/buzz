import { db, users } from "@buzz/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const build = {
  version: process.env.NEXT_PUBLIC_APP_VERSION,
  commit: process.env.NEXT_PUBLIC_APP_COMMIT,
};

export async function GET() {
  const startedAt = Date.now();

  try {
    await db.select({ id: users.id }).from(users).limit(1);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health.database",
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    return Response.json(
      { status: "degraded", database: "unreachable", ...build },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      status: "ok",
      database: "ok",
      latencyMs: Date.now() - startedAt,
      ...build,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
