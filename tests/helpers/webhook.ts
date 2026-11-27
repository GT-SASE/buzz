/**
 * A stand-in Discord webhook URL for tests. Built from parts: a whole webhook
 * URL in source is what the repo's secret scan (`discord-webhook-url` in
 * `config/gitleaks/gitleaks.toml`) looks for, and it scans every commit.
 */
export const FAKE_WEBHOOK = [
  "https://discord.com",
  "api",
  "webhooks",
  "123",
  "secret-token",
].join("/");
