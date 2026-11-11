# Runbook

What to do when the bot is in one of these states. For a leaked secret, see [SECURITY.md](../SECURITY.md). For restoring data, see [BACKUPS.md](BACKUPS.md).

The bot has not been deployed. Behaviour stated here was read from the code or run in tests with Discord mocked and PGlite in place of Postgres. Anything that depends on the real services is marked unverified and is listed under [Still to test on staging](#still-to-test-on-staging).

The SQL below only reads. Run it in the Supabase SQL editor, or as `backup_ro`. It ran on PGlite with the repo's migrations, not on hosted Supabase.

## Where to look

- `job_runs` is the record to trust. Each row has a `status` and a `results` object of counts and event IDs. A `reminders` row leaves a count of zero out of `results`. A `health_check` row can store a zero, such as `channels_ok: 0`.
- Vercel logs hold fixed text, IDs and error codes. Hobby keeps them for one hour.
- Each cron call returns 200 if the day's jobs succeeded, and 500 if not. Vercel does not alert on a 500.
- `backup/check-freshness.sh` fails when the last successful `reminders` row is over 30 hours old. It reads only that row's time, so it cannot see what a successful run left undone.

## Reminders held while the job is green

**This is a known gap.** If the bot loses Send Messages across a server while it can still read the forums, reminders stop going out, and the job turns green after three failed runs. No alert fires. An example of how this could happen: its channel overwrites are removed, while `@everyone` can still view the forums.

Why it happens:

1. A send answers 50001, 50013, 10004 or 160005. The bot then reads the event's forum to see whether the whole forum refuses it.
2. Reading a forum should take only View Channel (unverified on Discord), so the read succeeds and the refusal is blamed on that event's thread.
3. Each event keeps its own count in `events.thread_refusals`. Refusals 1 and 2 fail the run. From refusal 3 the event is held, and the run no longer fails for it.

With both crons firing, the order is failed at 14:00, failed at 16:00, succeeded at 14:00 the next day, after which the 16:00 cron finds the slot closed. The test run gave `failed, failed, succeeded, duplicate, succeeded`, with nothing sent. From the code, not a test: a run with a new event's first reminder fails again, because that event starts its own count at zero.

A held reminder is not lost. It keeps its claim and is tried once on each run. The first send that lands clears the count and logs `Reminders resumed for event <id>`. In tests the reminder then went out with its ping.

**How to spot it.** Nothing pushes this to you, so read it on a schedule. `/config` does not show held events.

```sql
SELECT started_at, status,
  results -> 'threads_held' AS threads_held,
  results -> 'held_reminders' AS held_reminders,
  results -> 'messages_sent' AS messages_sent,
  results -> 'held_event_ids' AS held_event_ids
FROM public.job_runs
WHERE job_name = 'reminders'
ORDER BY started_at DESC
LIMIT 7;

SELECT guild_id, channel_id, count(*) AS held_events
FROM public.events
WHERE thread_refusals >= 3 AND status = 'active' AND deleted_at IS NULL
GROUP BY guild_id, channel_id
ORDER BY guild_id, channel_id;
```

- One locked post looks like a small `threads_held`, with `messages_sent` present on the same runs.
- A server-wide loss looks like `succeeded` rows with `threads_held` and `channels_inaccessible` and no `messages_sent`, and held events in every forum that had a reminder due.
- `held_event_ids` lists at most 25 events. The counts and the second query cover them all.
- The health check row copies the count to `reminders_threads_held`, and logs `Latest reminder run needs a look: threads_held <n>`.
- `channels_ok` in the health check does not clear this. It proves only that the forum could be read.
- People may report it first: `/task assign` tells the officer that the person was not mentioned, because that post is refused too.

**To fix it.** In Discord, give the bot back the three permissions on each forum, as in [SETUP.md](SETUP.md#give-it-access-to-one-forum). If only one post is held, check whether it is locked. The next run that reaches the slot sends what was held. If today's run already succeeded, that is the next day's 14:00 cron. No database change is needed.

## The bot removed from a server, or the server deleted

The bot is not told, because it has no gateway connection. It finds out on the next send or forum read.

**If Discord answers 50001 or 10004 for the forum, the job keeps failing.** This is the case tests cover for a removed bot. The run does not hold anything, because the forum refuses too. It counts `channels_inaccessible`, logs `Forum refused the bot for event <id>`, and sends nothing. The slot stays open, each cron returns 500, and the freshness check fails after 30 hours. Reminders stay claimed. In tests they went out with their pings once the bot could post again.

**If Discord answers 10003 Unknown Channel for the thread and the forum, the job goes green.** The forum is marked `unavailable`, `channels_gone` is counted, and its events stop. This is the path for a deleted forum. `channels_gone` is not copied into the health check's attention counts, so read it from the `reminders` and `health_check` rows.

Unverified: which of these answers Discord gives for a removed bot or a deleted server. The answers in the tests are stand-ins.

**If the bot was removed by mistake:**

1. Invite it again with `permissions=0`, as in [SETUP.md](SETUP.md#invite-with-no-permissions).
2. Grant the three permissions on each forum again. Unverified: whether Discord kept the old overwrites, so check each one.
3. Run `npm run commands:register -- <guild-id>`. It replaces the server's whole command list, so running it again is safe. Unverified: whether Discord kept the commands.
4. Run `/config`. A forum marked `unavailable` shows as marked deleted but listed by Discord. Add it again to resume, which also redraws its 10 most recently changed posts.
5. Check the next `reminders` row for `status = 'succeeded'`. Expect `messages_sent` only if a reminder was due, as a quiet day has none.

**If the server is gone for good:**

1. Take the server's ID out of `ALLOWED_GUILD_IDS` in Vercel and redeploy. Runs then count `guilds_not_allowed` and skip it, and interactions from it are refused.
2. The setting cannot be empty. An empty value fails every run with a config error, so if this was the only server, leave the ID in and accept the failing job until there is a new one.
3. The server's rows stay in the database and in backups. Nothing removes them. See [Member data retention](#member-data-retention).

## A full database

Nothing has tested a full database on hosted Supabase. Unverified: the current Free plan limit, what Supabase does when it is reached and how to get out of that state. Read Supabase's current documentation. What follows assumes it goes read-only, as a stand-in test did, and that assumption is unverified too.

**What fills it.** `history.row_versions`, `job_runs`, `reminder_log`, `config_audit` and `task_reassignments` have no retention and only grow. Only `interaction_claims` is trimmed, by the daily job, and that write fails once the database refuses writes.

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;

SELECT n.nspname, c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname IN ('public', 'history')
ORDER BY pg_total_relation_size(c.oid) DESC;
```

**What the bot does, from the code and one test with writes refused in a PGlite session:**

- A reminder run stops at `begin_job_run`. It sends nothing and writes no `job_runs` row, so the failure shows only in the log line `Reminder run failed: unexpected:25006`, the cron's 500 and, after 30 hours, the freshness check. Unverified: that hosted PostgREST passes on the same code.
- No task is lost. The slot stays open, and after a gap only the most urgent reminder goes out.
- A state-changing command claims the interaction first. The claim fails, and the person gets the fixed failure reply with no change made.
- `/ping` needs no database. Commands that only read, and autocomplete, write nothing. Unverified: that reads keep working on the hosted database at that point.

**To respond:**

1. Check that the latest backup succeeded, and take one by hand if it can still run. See [BACKUPS.md](BACKUPS.md).
2. Do not delete rows by hand. No role has `DELETE` or `TRUNCATE` on the bot's tables on purpose, and schema changes go through migrations only.
3. Moving to a paid plan should lose nothing (unverified). That costs money, so it is the owner's decision.
4. There is no approved way to trim row history or old runs. Writing one depends on [the retention decision](#member-data-retention).
5. Afterwards, confirm the next `reminders` row succeeded. Tell people that reminders missed in the gap will not be sent one by one.

## Deploy order

**Migrations go first, then code.** A merge to `main` deploys by itself, because `vercel.json` turns on deployments for `main` and `staging`. No workflow applies migrations, so nothing keeps the two in step except doing them in this order.

1. Check that the branch is up to date with `main`. In a throwaway checkout:

   ```sh
   git fetch origin
   git switch --detach origin/main
   npm ci
   git merge-base --is-ancestor origin/main origin/<branch> || echo "behind main"
   ```

   If it prints `behind main`, rebase the branch on `main`, push it and start again. Step 3 replaces the migrations folder with the branch's, so on a branch that is behind it would drop `main`'s newer migrations, and steps 2 and 3 would check the wrong set. If `main` moves before the merge, repeat these checks.

2. Check for clashing versions. Supabase records a migration by its version, so two files sharing one cannot be pushed safely. This should print nothing:

   ```sh
   git ls-tree --name-only origin/<branch> supabase/migrations/ | sed 's|.*/||' | cut -c1-14 | sort | uniq -d
   ```

3. Check that the code now live works on the new schema. In the same checkout of `main`:

   ```sh
   git restore --source=origin/<branch> -- supabase/migrations
   npm run test:db
   ```

   Only tests that pin the schema should fail: exact grant lists, exact audit values, and anything that assumes which migration is last. Read each failure. For migrations 15 and 16 on the commit before them, 3 of 1460 tests failed, all of that kind. If real code fails, split the change in two: add the new thing in one release, and remove the old thing in a later one.

4. Apply to the test project: `supabase link --project-ref <test-project-ref>`, `supabase projects list` to confirm which project is linked, `supabase db push --dry-run`, then `supabase db push`. Deploy the code there and test. Do not use `--include-all`. If `link` or `db push` asks for `supabase/config.toml`, see [SETUP.md](SETUP.md), and do not commit it.
5. Apply to production the same way, with its own project ref, confirming the link before the dry run.
6. Merge to `main`, and check the next `reminders` and `health_check` rows.

Not run for this guide, as the Supabase CLI was not available: steps 4 and 5. Unverified: how quickly hosted PostgREST sees a new column or function after a push.

**If code reaches production first.** Code that needs a missing column or function fails. Checked once, for migration 15: the reminder code that needs it, on the schema before it, cannot read its candidates, so each run fails and sends nothing. The slot stays open, so apply the migration and the next cron recovers. If both crons of a day are missed, only the most urgent reminder goes out the next day.

**Rolling back onto a newer schema.** Instant Rollback changes the code and restores that deployment's cron definitions. It does not touch the database, and there are no down migrations.

- Old code usually works on a newer schema if the migrations only added things. The check in step 3 shows this for one pair of versions, and each release has to check its own.
- A rollback undoes that version's fixes. Never roll back past a security fix.
- To undo a schema change, write a new forward migration. Never change the schema by hand or in the dashboard.
- A deployment deleted after a secret rotation is no longer a rollback target, as [SECURITY.md](../SECURITY.md) explains.
- Unverified: Instant Rollback on the hosted platform. The staging checklist has a step for it.

**Restoring an older backup is the opposite case:** new code on an old schema. Follow "Real recovery" in [BACKUPS.md](BACKUPS.md), and bring the schema up to date before the bot takes traffic.

## Member data retention

**No retention period is set yet. This is an owner decision, and it has not been made.** Nothing removes member data on a schedule. Whether the club or the university has rules about this data has not been checked.

| Where                  | What it holds                                                    | How long                                                                           |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `events`, `tasks`      | Discord IDs of assignees and creators, task text and event names | Until someone decides otherwise. Deletes are soft, so the row stays                |
| `history.row_versions` | Old copies of `events` and `tasks` rows                          | No limit                                                                           |
| `config_audit`         | Discord IDs of who changed settings, role and forum IDs          | No limit                                                                           |
| `task_reassignments`   | Discord IDs of who reassigned a task                             | No limit                                                                           |
| `reminder_log`         | Which reminder went out for which task, and its message ID       | No limit                                                                           |
| `job_runs`             | Counts and event IDs                                             | No limit                                                                           |
| `interaction_claims`   | Interaction IDs                                                  | Removed by the daily job after a day                                               |
| Backups repository     | Everything above, encrypted                                      | Until that repository is deleted. [BACKUPS.md](BACKUPS.md#retention) says how      |
| Vercel logs            | Fixed text, IDs and error codes                                  | One hour on Hobby                                                                  |
| Discord                | The bot's posts and mentions                                     | The bot does not remove them. Deleting an event leaves its post, with a note in it |

The bot stores no member names in their own column, but task text and event names are free text, so a name can be in them.

**A member leaves.** The bot is not told. Their open tasks stay assigned, and reminders keep going to the post. An officer has to reassign or delete those tasks.

**Someone asks for their data to be removed.** There is no procedure for this yet. What exists today:

- `/task edit` changes the text and `/task delete` soft-deletes the task. Neither removes the old text from row history or backups.
- No role can hard-delete rows, by design, so removing them would need a migration written for it.
- Old backups can be removed only by deleting the whole old backups repository.

**What the owner has to decide:** how long each row above is kept, who answers a removal request, how a removal squares with the no-hard-delete rule, and whether club or university rules apply. Until then, tell the person what is kept and that no removal process exists.

## Still to test on staging

- [ ] A forum's overwrites removed while `@everyone` can still view it: that sends answer 50013 and reading the forum succeeds, so events are held.
- [ ] The bot removed from the test server: what a send and a forum read answer, whether commands and overwrites survive a new invite.
- [ ] The test server deleted, on a throwaway server: what the run records.
- [ ] A bot token can change the Interactions Endpoint URL, through `PATCH /applications/@me`. A token reset leaves that URL as it was. See [SECURITY.md](../SECURITY.md#after-a-bot-token-leak).
- [ ] The Free plan's database limit, what happens at it, and which code a refused write returns through PostgREST. Only on a project you are ready to recreate.
- [ ] How soon a pushed migration reaches PostgREST, and Instant Rollback onto a newer schema.
