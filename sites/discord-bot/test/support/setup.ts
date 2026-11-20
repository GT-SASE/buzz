/**
 * Preloaded before every test file (bunfig.toml).
 */

import { afterEach, mock } from "bun:test";
import { expectSentBodiesInert } from "./discord-server.ts";
import { restoreEnv } from "./stubs.ts";

// Date maths must never depend on the machine's zone. New York has DST, so code
// that slips into local time fails here even on a machine or CI runner set to UTC.
process.env.TZ = "America/New_York";

// Runs after each file's own afterEach hooks.
afterEach(() => {
  // Undoes every spyOn, the fetch stand-ins included.
  mock.restore();
  restoreEnv();
  expectSentBodiesInert();
});
