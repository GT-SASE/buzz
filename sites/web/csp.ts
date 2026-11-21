import { uptimeDataUrl } from "./src/lib/uptime";

/**
 * One policy for every route. A browser fixes the policy when the document
 * loads and App Router links keep that document, so a rule for one route only
 * applies to the first page a visitor opens, never to one they click through to.
 *
 * Requests: this origin (tRPC, auth, and Vercel Analytics and Speed Insights,
 * which load from /_vercel/*) plus the GitHub raw host /status reads the
 * uptime file from.
 *
 * Images keep `https:` on purpose. Officers embed images by URL in the Markdown
 * pages (components/site/markdown.tsx), published and in the editor preview, and
 * a host list would break them silently. Once uploads land (v3 P15) images can
 * shrink to this origin and data: URLs.
 *
 * Production scripts keep 'unsafe-inline' because a nonce forces every page to
 * render per request; AGENTS.md has the measurement.
 */
export function contentSecurityPolicy(isProd: boolean) {
  return [
    "default-src 'self'",
    isProd
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${new URL(uptimeDataUrl).origin}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
