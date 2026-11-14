# Runbook

What to do when the bot is in one of these states. For a leaked secret, see [SECURITY.md](../SECURITY.md). For restoring data, see [RECOVERY.md](RECOVERY.md).

Behaviour stated here was read from the code or run in tests with Discord mocked and PGlite or Postgres 17 in place of Neon. The SQL below only reads. Run it as the owner, in Neon's SQL editor or `psql`.

## When it runs

- The daily job runs from two Vercel Cron schedules in `vercel.json`: the morning run at 15:00 UTC, which is 10 AM Eastern in winter and 11 AM in summer, and the recovery run at 17:00 UTC. Each can fire any time in its hour. The recovery run does nothing after a good morning run, and carries on after a failed one.
- A Discord failure that is not about one event's post, such as an outage, a rate limit or a refused token, stops the run, and the recovery run carries on. If both runs of a day stop, that day's remaining reminders are skipped, and the next day's go out as usual.
- A locked or inaccessible post makes the reminder run fail until someone fixes the post or closes the event. Logs say `Thread refused the bot for event <id>`, and the other events' reminders still go out.

## Where to look

- `job_runs` is the record to trust. Each row has a `status` and a `results` object of counts and event IDs. A `reminders` row leaves a count of zero out of `results`. A `health_check` row can store a zero, such as `channels_ok: 0`.
- Vercel logs hold fixed text, IDs and error codes. Hobby keeps them for one hour.
- Each cron call returns 200 if the day's jobs succeeded, and 500 if not. Vercel does not alert on a 500.
- Nothing outside the bot alerts when reminders stop or fail. Look at the newest `reminders` rows in `job_runs` each week. Each `health_check` row records `reminders_stale` once the last good run is over 26 hours old, but it is written by the same cron, so it cannot report a cron that stopped.

```sql
SELECT started_at, status, error, results
FROM public.job_runs
WHERE job_name = 'reminders'
ORDER BY started_at DESC
LIMIT 7;
```

- `channels_inaccessible` means a post or forum refused the bot. Check whether the post is locked, and give the bot back its three permissions on the forum, as in [SETUP.md](SETUP.md#7-invite-the-bot-and-register-commands).
- `deferred_halted` counts reminders left when a run stopped. The recovery run or the next day takes them.
- `deferred_cap`, `threads_missing` and `events_stopped` are copied into the health check row as `reminders_<key>`, with a log line `Latest reminder run needs a look`.

## Event step and Food pickup reminders

The same `reminders` run sends these after the task reminders, under the same lock, message cap and deadlines. Each is one message in the event's post, recorded in `event_reminder_log` under the guild's local date it is for.

- `daily_steps` goes out each day up to the event's date while Budget Sheet, Engage post or Budget approved is open. It never mentions Food pickup. It pings the Events Directors role for a Budget Sheet or Engage post with nobody on it.
- `pickup_before` and `pickup_day` go out two days before and on the event's date, only once Food pickup has a time and at least one person on it. The database refuses a claim after the event's date, or for a day other than today or yesterday in the guild's zone; the planner picks the day for each kind. Neither waits for the budget to be approved.
- None is sent late. A claim left from a day that has passed is closed as `skipped` by a later run.

Their counts in `results` start with `event_`, such as `event_reminders_sent` and one `event_<kind>_sent` per kind. `event_render_failed` means an event's reminder could not be written, and the logs name the event. `event_items_refused` means Discord refused the text itself: the reminder is recorded as `skipped`, and the next day brings a new one.

To see what went out for an event:

```sql
SELECT kind, reminder_date, state, attempts, claimed_at, sent_at
FROM public.event_reminder_log
WHERE event_id = '<event-id>'
ORDER BY reminder_date, kind;
```

A claim over 2 minutes old is stale. A later run sends it if it is still due, or closes it as `skipped` if it will never go out: a day that has passed, a pickup reminder after Food pickup was undone, a finished or deleted task, a closed or deleted event, or a post that is gone. A claim in a forum no longer managed, or on a guild with reminders off, is left alone. Each run reads at most 500 stale claims, oldest first, and counts `stale_truncated` or `event_stale_truncated` when there are more, so the recovery run carries on.

Both runs of a day plan for the guild's local date when the morning run's slot begins, so the recovery run plans the same day even where local midnight falls between the two. A run started by hand before the morning run belongs to the slot that began the day before.

## The bot removed from a server, or the server deleted

The bot is not told, because it has no gateway connection. It finds out on the next send or forum read.

**If Discord answers 50001 or 10004, the job keeps failing.** This is the case tests cover for a removed bot. The run counts `channels_inaccessible`, logs `Thread refused the bot for event <id>`, and sends nothing. Each cron returns 500, and the health check records `reminders_stale` once the last good run is over 26 hours old. Reminders stay claimed, and in tests they went out with their pings once the bot could post again.

**If Discord answers 10003 Unknown Channel for the thread and the forum, the job goes green.** The forum is marked `unavailable`, `channels_gone` is counted, and its events stop. This is the path for a deleted forum. `channels_gone` is not copied into the health check's attention counts, so read it from the `reminders` and `health_check` rows.

Which of these Discord gives for a removed bot or a deleted server is unconfirmed.

**If the bot was removed by mistake:**

1. Invite it again with `permissions=0`, as in [SETUP.md](SETUP.md#7-invite-the-bot-and-register-commands).
2. Grant the three permissions on each forum again. Discord may not have kept the old overwrites, so check each one.
3. Run `bun run commands:register <guild-id>`. It replaces the server's whole command list, so running it again is safe.
4. Run `/config`. A forum marked `unavailable` shows as marked deleted but listed by Discord. Add it again to resume, which also redraws its 10 most recently changed posts.
5. Check the next `reminders` row for `status = 'succeeded'`. Expect `messages_sent` only if a reminder was due, as a quiet day has none.

**If the server is gone for good:**

1. Take the server's ID out of `ALLOWED_GUILD_IDS` in Vercel and redeploy. Runs then count `guilds_not_allowed` and skip it, and interactions from it are refused.
2. The setting cannot be empty. An empty value fails every run with a config error, so if this was the only server, leave the ID in and accept the failing job until there is a new one.
3. The server's rows stay in the database, in Neon's history for its restore window and in manual exports. Nothing removes them. See [Member data retention](#member-data-retention).

## A full database

Check the size on the project's usage page in the Neon console. `history.row_versions`, `job_runs` and the reminder logs only grow. Do not delete rows by hand: `bot_app` has no `DELETE` or `TRUNCATE` on purpose, and schema changes go through migrations only. If the database is near the plan's limit, take a manual export as in [RECOVERY.md](RECOVERY.md) and move to a paid plan, which is the owner's decision.

## Deploy order

**Migrations go first, then code.** A merge to `main` deploys by itself, because `vercel.json` turns on deployments for `main` only. No workflow applies migrations, so nothing keeps the two in step except doing them in this order.

1. Check that the branch is up to date with `main`. In a throwaway checkout:

   ```sh
   git fetch origin
   git switch --detach origin/main
   bun install --frozen-lockfile
   git merge-base --is-ancestor origin/main origin/<branch> || echo "behind main"
   ```

   If it prints `behind main`, rebase the branch on `main`, push it and start again. Step 2 replaces the migrations folder with the branch's, so on a branch that is behind it would drop `main`'s newer migrations, and steps 2 and 3 would check the wrong set. If `main` moves before the merge, repeat these checks.

2. Check the branch's migrations. A new file is made with `dbmate new`, which names it by the time, and an applied file never changes. In the same checkout:

   ```sh
   git restore --source=origin/<branch> -- db/migrations
   git diff --stat origin/main -- db/migrations
   ```

   The diff must show only added files.

3. Check that the code now live works on the new schema:

   ```sh
   bun run test:db
   ```

   Only tests that pin the schema should fail, such as exact audit values or anything that assumes which migration is last. Read each failure. If real code fails, split the change in two: add the new thing in one release, and remove the old thing in a later one.

4. Apply the migrations as the owner, with the direct connection string, and read the host in it first:

   ```sh
   read -rs OWNER_URL
   DATABASE_URL="$OWNER_URL" bun run db:migrate
   DATABASE_URL="$OWNER_URL" bunx --no-install dbmate --migrations-dir db/migrations status
   ```

   The first lists the files it applied, and the second should show nothing pending.

5. Merge to `main`, run the smoke checks that touch the change on the test server, and check the next `reminders` and `health_check` rows.

**If code reaches production first.** Code that needs a missing column or function fails. Checked once, before the schema became one baseline, for a migration the reminder code needed: that code, on the schema before it, cannot read its candidates, so each run fails and sends nothing. The slot stays open, so apply the migration and the next run recovers. If both runs of a day are missed, only the most urgent reminder goes out the next day.

**Rolling back onto a newer schema.** Instant Rollback changes the code and restores that deployment's cron definitions. It does not touch the database, and there are no down migrations.

- Old code usually works on a newer schema if the migrations only added things. The check in step 3 shows this for one pair of versions, and each release has to check its own.
- A rollback undoes that version's fixes. Never roll back past a security fix.
- To undo a schema change, write a new forward migration. Never change the schema by hand or in the dashboard.
- A deployment deleted after a secret rotation is no longer a rollback target, as [SECURITY.md](../SECURITY.md) explains.

**Restoring to an earlier point is the opposite case:** new code on an old schema. Follow [RECOVERY.md](RECOVERY.md), and bring the schema up to date before the bot takes traffic.

## Member data retention

**No retention period is set yet. This is an owner decision, and it has not been made.** Nothing removes member data on a schedule. Whether the club or the university has rules about this data has not been checked.

| Where                  | What it holds                                                    | How long                                                                           |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `events`, `tasks`      | Discord IDs of assignees and creators, task text and event names | Until someone decides otherwise. Deletes are soft, so the row stays                |
| `history.row_versions` | Old copies of events, tasks, steps, settings, forums and drafts  | No limit                                                                           |
| `config_audit`         | Discord IDs of who changed settings, role and forum IDs          | No limit                                                                           |
| `task_reassignments`   | Discord IDs of who reassigned a task                             | No limit                                                                           |
| `reminder_log`         | Which reminder went out for which task, and its message ID       | No limit                                                                           |
| `event_reminder_log`   | Which step or pickup reminder went out for which event, and when | No limit                                                                           |
| `job_runs`             | Counts and event IDs                                             | No limit                                                                           |
| `interaction_claims`   | Interaction IDs                                                  | Hard-deleted by `expire_interaction_claims` after a day                            |
| Neon's history         | Everything above                                                 | The plan's restore window                                                          |
| Manual exports         | Everything above                                                 | The last two are kept, as [RECOVERY.md](RECOVERY.md#a-manual-export) says          |
| Vercel logs            | Fixed text, IDs and error codes                                  | One hour on Hobby                                                                  |
| Discord                | The bot's posts and mentions                                     | The bot does not remove them. Deleting an event leaves its post, with a note in it |

The bot stores no member names in their own column, but task text and event names are free text, so a name can be in them.

**A member leaves.** The bot is not told. Their open tasks stay assigned, and reminders keep going to the post. An officer has to reassign or delete those tasks.

**Someone asks for their data to be removed.** There is no procedure for this yet. What exists today:

- `/task edit` changes the text and `/task delete` soft-deletes the task. Neither removes the old text from row history, Neon's restore history or exports.
- `bot_app` cannot hard-delete rows, by design, so removing them would need a migration written for it.
- Neon's history expires with its restore window. Manual exports are removed by deleting the file.

**What the owner has to decide:** how long each row above is kept, who answers a removal request, how a removal squares with the no-hard-delete rule, and whether club or university rules apply. Until then, tell the person what is kept and that no removal process exists.
