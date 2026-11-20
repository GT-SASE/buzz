/**
 * Copies the built functions to a folder outside the repository, so nothing can
 * resolve through the repository's node_modules, then checks that each handler loads
 * and refuses an unauthenticated request. Calls neither Discord nor a database.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const built = path.join(import.meta.dirname, "../.vercel/output/functions/api");
const copy = await mkdtemp(path.join(tmpdir(), "bot-functions-"));
await cp(built, copy, { recursive: true });

// A usable cron secret is set, so the refusal comes from the missing header.
process.env.CRON_SECRET = "x".repeat(64);

async function serve(route) {
  const { default: handler } = await import(
    pathToFileURL(path.join(copy, `${route}.func`, "index.mjs")).href
  );
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.writeHead(500).end());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function status(server, url, init) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${url}`, init);
  return response.status;
}

const interactions = await serve("interactions");
const cron = await serve("cron/reminders");
try {
  assert.equal(
    await status(interactions, "/api/interactions", {
      method: "POST",
      body: "{}",
    }),
    401,
  );
  assert.equal(await status(cron, "/api/cron/reminders"), 401);
  console.log("interactions: unsigned POST refused with 401");
  console.log("cron/reminders: GET without the bearer token refused with 401");
} finally {
  interactions.close();
  cron.close();
  await rm(copy, { recursive: true, force: true });
}
