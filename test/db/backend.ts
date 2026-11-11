/**
 * Where the access layer tests run. With POSTGREST_URL set they go through a real
 * PostgREST server, which is what CI does, and otherwise through the local stand-in
 * on PGlite. The client under test is the same in both: only `fetch` differs.
 */

import { createHmac } from "node:crypto";
import pg from "pg";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { TEST_ORIGIN, TEST_SECRET_KEY } from "../support/mock-postgrest.ts";
import { createMigratedDb, pgConnection, type Connection } from "./harness.ts";
import { postgrestShim } from "./postgrest-shim.ts";

export interface Backend {
  /** A superuser connection, for setting up rows the bot's role cannot write. */
  connection: Connection;
  db: DbClient;
  /** A client that runs `before` ahead of each request, to stage a race at that point. */
  dbWith: (before: (method: string, path: string) => Promise<void>) => DbClient;
  close: () => Promise<unknown>;
}

function clientFor(send: typeof fetch): DbClient {
  return createDbClient({
    url: TEST_ORIGIN,
    secretKey: TEST_SECRET_KEY,
    fetch: send,
  });
}

function withBackend(
  send: typeof fetch,
  connection: Connection,
  close: () => Promise<unknown>,
): Backend {
  return {
    connection,
    db: clientFor(send),
    dbWith: (before) =>
      clientFor(async (input, init) => {
        const url =
          typeof input === "string" || input instanceof URL ? input : input.url;
        await before(init?.method ?? "GET", new URL(url).pathname);
        return send(input, init);
      }),
    close,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set to run against real PostgREST`);
  }
  return value;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function serviceRoleToken(secret: string): string {
  const signed = [
    base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    base64url(
      JSON.stringify({
        role: "service_role",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  ].join(".");
  const signature = createHmac("sha256", secret)
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

/**
 * PostgREST has no Supabase gateway in front of it, so this does the gateway's job:
 * it sends the request to the server's own path, with the JWT the gateway would mint.
 */
function fetchThroughPostgrest(baseUrl: string, secret: string): typeof fetch {
  const token = serviceRoleToken(secret);
  return (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const headers = new Headers(init?.headers);
    headers.delete("apikey");
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(
      `${baseUrl}${url.pathname.replace(/^\/rest\/v1/, "")}${url.search}`,
      { ...init, headers },
    );
  };
}

export async function openBackend(): Promise<Backend> {
  const postgrestUrl = process.env.POSTGREST_URL;
  if (postgrestUrl !== undefined && postgrestUrl !== "") {
    const client = new pg.Client({
      connectionString: required("POSTGREST_DATABASE_URL"),
    });
    await client.connect();
    return withBackend(
      fetchThroughPostgrest(postgrestUrl, required("PGRST_JWT_SECRET")),
      pgConnection(client),
      () => client.end(),
    );
  }
  const database = await createMigratedDb();
  return withBackend(postgrestShim(database), database, () => database.close());
}
