# Recovery

How to get data back. For a leaked secret, see [SECURITY.md](../SECURITY.md). Nothing here has been run on Neon.

Three layers, smallest first:

1. **Undo one change by hand.** Deletes are soft and `history.row_versions` keeps old copies of every changed or removed row of `events`, `tasks`, `event_steps`, `event_step_assignees`, `guild_config`, `managed_channels` and `setup_drafts`, so most mistakes need no restore. See [Undoing a change](#undoing-a-change).
2. **Neon's point-in-time restore.** Neon keeps the database's recent history, so a branch can be restored to an earlier moment. Use it when data is lost or damaged across the board.
3. **A manual export.** An occasional `pg_dump` kept privately, for when the damage is older than Neon's restore window, or Neon is out of reach, such as after losing the account.

There is no backup job of the bot's own.

## Neon's point-in-time restore

Unverified: how far back the current plan can restore. Check the restore window in the project's settings, and Neon's current documentation, when the project is set up and once a term. On the Free plan it is short. If the damage may be older than the window, the manual export below is the only copy, so take it more often.

To restore:

1. Turn reminders off with `/config` if the bot can still run, so it does not send from data that is about to change.
2. Look before you restore. Create a new branch from the production branch at a past time, the last moment before the damage, and connect to it as the owner to check that the data there is right. A branch made this way is a copy, and changes nothing on the production branch. Delete it when you are done.
3. Restore the production branch to that time, from its page in the Neon console. Check this in the dashboard. A restore replaces the whole branch, and Neon keeps the state from before it as a separate branch. Unverified: whether the bot's connection string keeps working afterwards, as the branch keeps its compute.
4. A restore also brings back roles as they were then. If `bot_app`'s password was changed since that time, the old one is back, so set the current one again with `ALTER ROLE bot_app PASSWORD '<password>';` as the owner. It also brings back the reminders setting as it was then, so turn reminders off again straight after.
5. Check that the restored database has every migration. Run `bun run db:migrate` as the owner, as [RUNBOOK.md](RUNBOOK.md#deploy-order) describes. It applies any that are missing and prints nothing if none are. Code newer than the schema can fail, so do this before the bot takes traffic.
6. Check `job_runs` and a few recent events and tasks, then turn reminders back on.

Anything done between that time and the restore is lost, including posts the bot made in Discord, which stay in Discord. Tell people to check their tasks.

## A manual export

Take one before a risky migration, and otherwise once a term. You need a Postgres 17 `pg_dump`. Use the owner's direct connection string, from Neon's Connect dialog with pooling off. `read -rs` waits for you to paste it, and keeps it out of your shell history and off the screen. Never put it in the command or a file in this repo.

```sh
read -rs OWNER_URL
pg_dump --format=custom --no-owner --schema=public --schema=history \
  --file="bot-$(date +%Y-%m-%d).dump" "$OWNER_URL"
pg_restore --list "bot-$(date +%Y-%m-%d).dump" | head
unset OWNER_URL
```

**Expect:** the list names the app's tables. The file holds member IDs and task text:

- Encrypt it, and keep it somewhere private that only the maintainer and one other trusted officer can reach, never in this repository or a chat. `.gitignore` blocks `*.dump`, but do not rely on that.
- Keep the last two and delete older ones, in line with [Member data retention](RUNBOOK.md#member-data-retention).

Restoring an export is untested. Rehearse it on a new, empty Neon project before relying on it, restoring as that project's owner with `pg_restore --no-owner --single-transaction`. The export holds `public.schema_migrations`, so `bun run db:migrate` afterwards should print nothing. It does not hold roles, and its grants name `bot_app`, so that role has to exist first. Unverified: the order of steps that works. Then set `bot_app`'s password and point `DATABASE_URL` in Vercel at the new project's `bot_app` string, built as in [SETUP.md](SETUP.md#build-the-bots-connection-string). Write down what worked here.

## Undoing a change

No bot command reverses `/event close`, Mark done or `/event delete`, because nothing is really deleted and a mistake is rare. A maintainer does it by hand. Run these as the tables' owner, which on Neon is the project's owner role, in Neon's SQL editor or `psql`. Each one should report that it changed 1 row.

Row history covers `events` and `tasks`, and these changes add to it. What SQL changes does not reach Discord: the post's overview stays as it was until the next change to that event's tasks. Reminder rows are kept, so a reminder already sent or skipped for a task's due date is not sent again.

Find the full IDs first. Commands show only the start of one.

```sql
SELECT id, name, event_date, status, deleted_at FROM public.events WHERE name ILIKE '%<part of the name>%';
SELECT id, description, due_date, status, deleted_at FROM public.tasks WHERE event_id = '<event id>';
```

**Reopen a closed event.** Its open tasks get reminders again.

```sql
-- undo: reopen event
UPDATE public.events SET status = 'active'
WHERE id = '<event id>' AND status = 'closed' AND deleted_at IS NULL;
```

**Reopen a task marked done.** Reopen its event first if that is closed too, or this fails with `CF410`, even as the owner.

```sql
-- undo: reopen task
UPDATE public.tasks SET status = 'open', completed_at = NULL
WHERE id = '<task id>' AND status = 'done';
```

**Undelete an event and its tasks.** `/event delete` gives the event and its tasks one timestamp, so matching on it brings back only those tasks. A task deleted earlier stays deleted. Keep the comparison in SQL as written, because a timestamp copied through other tools can lose its microseconds and then match nothing.

```sql
-- undo: undelete event
WITH gone AS (
  SELECT id, deleted_at FROM public.events WHERE id = '<event id>'
), tasks AS (
  UPDATE public.tasks AS task SET deleted_at = NULL
  FROM gone
  WHERE task.event_id = gone.id AND task.deleted_at = gone.deleted_at
  RETURNING 1
)
UPDATE public.events SET deleted_at = NULL
WHERE id = '<event id>' AND deleted_at IS NOT NULL;
```

**If that fails with `23505`** on `events_live_thread_uq`, its post now belongs to another event. See which one:

```sql
-- undo: find post holder
SELECT live.id, live.name, live.event_date
FROM public.events AS live
JOIN public.events AS gone ON gone.thread_id = live.thread_id
WHERE gone.id = '<event id>' AND live.deleted_at IS NULL;
```

Leave that post with the other event, and undelete this one without a post. Then in Discord, run `/event link` inside a new post in the same forum and choose this event in the event option. Until then it has no post and sends no reminders.

```sql
-- undo: undelete event without its post
WITH gone AS (
  SELECT id, deleted_at FROM public.events WHERE id = '<event id>'
), tasks AS (
  UPDATE public.tasks AS task SET deleted_at = NULL
  FROM gone
  WHERE task.event_id = gone.id AND task.deleted_at = gone.deleted_at
  RETURNING 1
)
UPDATE public.events
SET deleted_at = NULL, thread_id = NULL, overview_message_id = NULL, thread_status = 'pending'
WHERE id = '<event id>' AND deleted_at IS NOT NULL;
```

**Undelete one task.** Only the tables' owner can do this: a trigger refuses it for any other role, so the bot can never undelete a task. Check first that its event is live, because this is not refused under a deleted event.

```sql
-- undo: undelete task
UPDATE public.tasks SET deleted_at = NULL
WHERE id = '<task id>' AND deleted_at IS NOT NULL;
```

**Put back an earlier assignee, description or due date.** List the versions, newest first. Each `old_row` is the row as it was before that change. Then copy the chosen version's `id` into the update. A closed event refuses this with `CF410` until it is reopened.

```sql
-- undo: list task versions
SELECT id, changed_at, old_row FROM history.row_versions
WHERE source_table = 'tasks' AND row_id = '<task id>'
ORDER BY id DESC;
```

```sql
-- undo: restore task version
UPDATE public.tasks AS task
SET assignee_id = version.old_row ->> 'assignee_id',
    description = version.old_row ->> 'description',
    due_date = (version.old_row ->> 'due_date')::date
FROM history.row_versions AS version
WHERE version.id = <version id>
  AND version.source_table = 'tasks'
  AND task.id::text = version.row_id;
```
