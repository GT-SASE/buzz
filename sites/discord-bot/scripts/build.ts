/**
 * Builds the bot's two functions into Vercel's Build Output API (version 3) layout
 * under .vercel/output. Each function is one bundle with every dependency inlined,
 * so the deployment needs no node_modules and no file tracing.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CRONS, FUNCTIONS, MAX_DURATION_SECONDS } from "./deployment.ts";

const root = path.join(import.meta.dirname, "..");
const output = path.join(root, ".vercel/output");
const entries = path.join(root, ".vercel/entries");

const NODE_RUNTIME = "nodejs24.x";

await rm(output, { recursive: true, force: true });
await rm(entries, { recursive: true, force: true });
await mkdir(entries, { recursive: true });

for (const { route, source } of FUNCTIONS) {
  const entry = path.join(entries, `${route.replaceAll("/", "-")}.ts`);
  await writeFile(
    entry,
    [
      `import * as route from ${JSON.stringify(path.join(root, source))};`,
      `import { toNodeHandler } from ${JSON.stringify(path.join(root, "scripts/node-adapter.ts"))};`,
      "export default toNodeHandler(route);",
      "",
    ].join("\n"),
  );

  const functionDir = path.join(output, "functions", `${route}.func`);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: functionDir,
    naming: "index.mjs",
    target: "node",
    format: "esm",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  await writeFile(
    path.join(functionDir, ".vc-config.json"),
    `${JSON.stringify({ runtime: NODE_RUNTIME, handler: "index.mjs", launcherType: "Nodejs", maxDuration: MAX_DURATION_SECONDS }, null, 2)}\n`,
  );
}

await cp(path.join(root, "public"), path.join(output, "static"), {
  recursive: true,
});
await writeFile(
  path.join(output, "config.json"),
  `${JSON.stringify({ version: 3, routes: [{ handle: "filesystem" }], crons: CRONS }, null, 2)}\n`,
);
await rm(entries, { recursive: true, force: true });
