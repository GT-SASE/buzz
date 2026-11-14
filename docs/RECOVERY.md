# Recovery

How to get data back. For a leaked secret, see [SECURITY.md](../SECURITY.md).

Deletes are soft and `history.row_versions` keeps old copies of changed rows, so most mistakes need only [the SQL below](#undoing-a-change). For damage across the board, use [Neon's point-in-time restore](https://neon.com/docs/postgres/backup-restore/branch-restore), then set `bot_app`'s password again and run `bun run db:migrate` as the owner. For damage older than Neon's restore window, or a lost account, use a manual export.

## A manual export

Take one before a risky migration, and otherwise once a term, with a Postgres 17 `pg_dump` and the owner's direct connection string (pooling off). `read -rs` keeps the string out of your shell history.

```sh
read -rs OWNER_URL
pg_dump --format=custom --no-owner --schema=public --schema=history \
  --file="bot-$(date +%Y-%m-%d).dump" "$OWNER_URL"
pg_restore --list "bot-$(date +%Y-%m-%d).dump" | head
unset OWNER_URL
```

The file holds member IDs and task text. Encrypt it, keep it private and out of this repository, and keep only the last two, as [Member data retention](RUNBOOK.md#member-data-retention) says.

## Undoing a change

Run these as the tables' owner, in Neon's SQL editor or `psql`. Each should change 1 row. Discord isn't updated: an event's overview stays as it was until its next change. Find the full IDs first:

```sql
SELECT id, name, event_date, status, deleted_at FROM public.events WHERE name ILIKE '%<part of the name>%';
SELECT id, description, due_date, status, deleted_at FROM public.tasks WHERE event_id = '<event id>';
```

**Reopen a closed event**, then **a task marked done** (a task under a closed event fails with `CF410`):

```sql
UPDATE public.events SET status = 'active'
WHERE id = '<event id>' AND status = 'closed' AND deleted_at IS NULL;
UPDATE public.tasks SET status = 'open', completed_at = NULL
WHERE id = '<task id>' AND status = 'done';
```

**Undelete an event and the tasks deleted with it.** If this fails with `23505` on `events_live_thread_uq`, another event now has its post: also set `thread_id = NULL, overview_message_id = NULL, thread_status = 'pending'`, then run `/event link` in a new post.

```sql
WITH gone AS (SELECT id, deleted_at FROM public.events WHERE id = '<event id>'),
tasks AS (
  UPDATE public.tasks AS task SET deleted_at = NULL FROM gone
  WHERE task.event_id = gone.id AND task.deleted_at = gone.deleted_at RETURNING 1
)
UPDATE public.events SET deleted_at = NULL
WHERE id = '<event id>' AND deleted_at IS NOT NULL;
```

**Undelete one task** (only the owner can; check its event is live first), or **put back an earlier version** of one, listed newest first:

```sql
UPDATE public.tasks SET deleted_at = NULL WHERE id = '<task id>' AND deleted_at IS NOT NULL;
SELECT id, changed_at, old_row FROM history.row_versions
WHERE source_table = 'tasks' AND row_id = '<task id>' ORDER BY id DESC;
UPDATE public.tasks AS task
SET assignee_id = version.old_row ->> 'assignee_id',
    description = version.old_row ->> 'description',
    due_date = (version.old_row ->> 'due_date')::date
FROM history.row_versions AS version
WHERE version.id = <version id> AND version.source_table = 'tasks' AND task.id::text = version.row_id;
```
