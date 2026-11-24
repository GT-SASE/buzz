import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright-core";

/**
 * axe on the built marketing routes. Run after `bun run vercel-build`, with
 * `next start` already serving the build on BASE_URL (default
 * http://localhost:3000). Fails on serious and critical violations only.
 * Uses the Chrome installed on the machine (the CI runner image ships it).
 */
const base = process.env.BASE_URL ?? "http://localhost:3000";
const routes = ["/", "/events", "/join", "/sponsors", "/board", "/faq"];

const browser = await chromium.launch({ channel: "chrome" });
let failed = false;
try {
  for (const route of routes) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + route, { waitUntil: "load" });
    const { violations } = await new AxeBuilder({ page }).analyze();
    const bad = violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    console.log(
      `${bad.length ? "FAIL" : "ok  "} ${route} (${violations.length} total, ${bad.length} serious/critical)`,
    );
    for (const v of bad) {
      failed = true;
      console.error(`  ${v.impact} ${v.id}: ${v.help}`);
      for (const n of v.nodes.slice(0, 3))
        console.error(`    ${n.target.join(" ")}`);
    }
    await page.context().close();
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
