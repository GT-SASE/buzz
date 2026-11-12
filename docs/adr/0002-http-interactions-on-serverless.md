# 2. HTTP interactions on serverless hosting

Status: Accepted. Implemented: the signed endpoint, the two cron schedules, reminders and the health check. The bot runs on a private test server, and the Neon setup has not yet been tried live, so `docs/STAGING_CHECKLIST.md` lists what real services still have to prove.

## Context

The bot has to cost $0 per month and serves one club, with low traffic. A gateway bot needs a process holding a WebSocket open all day, which free serverless hosting does not provide. Discord can instead POST each slash command and component click to an HTTPS endpoint. Reminders only need daily precision.

## Decision

Run as TypeScript functions on Vercel Hobby, with Postgres 17 on Neon for storage. Receive Discord HTTP interactions only, and open no gateway connection. Verify the Ed25519 signature on the raw body before anything else, reject timestamps older than 5 minutes, and answer a verified PING with PONG. Every other interaction must come from a server in `ALLOWED_GUILD_IDS`.

Run the daily job for reminders and the health check from two Vercel Cron schedules on one path, at 15:00 and 17:00 UTC, protected by `CRON_SECRET` on the assumption that the URL is public. A slot starts at 15:00 UTC each day. A run that succeeds refuses later ones until the next slot, so the 17:00 cron does nothing after a good morning and recovers a failed one. A reminder is claimed, sent, then marked sent. A claim older than an hour counts as stale and is retried by a later run. If several reminders are due for a task, only the most urgent is sent.

## Consequences

- **The bot only sees what it is sent.** Beyond what an interaction itself carries, such as the message a clicked component belongs to, it receives no message content, reactions, member joins or leaves, role changes, or channel and thread events. It cannot react to activity in a forum, and it gets no notice when a role is granted.
- A deleted channel goes unnoticed until the next health check or failed send, up to a day later. A member who has left may stay assigned to tasks.
- Discord requires a first response within 3 seconds, and cold starts eat into that. Slow work must be deferred and finished as a follow-up, using a token valid for 15 minutes. It must be kept alive after the response with `waitUntil`, and it shares the function's timeout.
- On Hobby each schedule runs at most once a day and can fire any time within its hour, so reminders land in a window, not at a set time. Vercel does not retry a failed run, and delivery is best effort, so a run can be missed without a log or invoked twice. The 17:00 cron is the only retry. If both runs of a day fail or are missed, nothing goes out until the next day.
- Whether two schedules on one path deploy and fire on Hobby must be checked on staging. Vercel's docs show the shape, and its example is not on Hobby. Nothing inside a cron can report that it did not run, so the newest successful run in `job_runs` has to be checked from outside, as the runbook says.
- A crash between send and mark can resend that reminder on the next run, and again if the crash repeats. We accept this over missing a deadline.
- A flood of requests could exhaust Hobby limits and take the bot offline. Vercel says that in most cases a Hobby account over its limits must wait until 30 days have passed to use the feature again. This costs availability, not money.
- Vercel Hobby is restricted to non-commercial personal use. A volunteer bot with no payments or ads does not match Vercel's examples of commercial use, but the docs do not say whether a student organisation's bot counts as personal, so ask Vercel Support if in doubt. Neon's Free plan stops the database's compute after a few minutes with no queries, and the first query after that waits for it to start. Whether that start fits in the time Discord allows must be checked on staging.
- Moving to a gateway connection later would need always-on hosting, which may no longer be free.
