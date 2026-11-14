// Preloaded by `bun run test:db:concurrency`. A missing setting or a wrong server
// stops the run here, once, before any file starts. The script also sets CI=true, so
// a test.only fails the run instead of skipping the other tests.
import { setUpOnce } from "./global-setup.ts";

try {
  await setUpOnce();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
