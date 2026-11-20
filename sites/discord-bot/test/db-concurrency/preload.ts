// Preloaded by `bun run test:db:concurrency`. A missing setting or a wrong server
// stops the run here, once, before any file starts.
import { setUpOnce } from "./global-setup.ts";

try {
  await setUpOnce();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
