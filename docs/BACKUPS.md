# Backups

A daily job in a separate private repo streams `pg_dump` through `age` and commits only the encrypted result. This repo never holds database secrets, so the workflow is kept here only as a template.

| Piece                                | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `backup/backup.workflow.yml.example` | The workflow, with pinned action, client and `age` versions  |
| `backup/run-backup.sh`               | Dumps, encrypts and checks row counts                        |
| `backup/check-freshness.sh`          | Fails if the reminder job has stopped succeeding             |
| `backup/copy-summary.awk`            | Counts rows in the dump stream, in memory                    |
| `backup/verify-restore.sh`           | Restores into a local scratch database and compares          |
| `backup/create-backup-role.psql`     | Creates `backup_ro` on a new project during a recovery       |
| `backup/grant-backup-role.psql`      | Gives `backup_ro` its access back after a recovery's restore |
| `20261104000009_backup_role.sql`     | Creates `backup_ro` with read access and no login            |
| `scripts/test-backup-restore.sh`     | Runs all of this on real Postgres, in the Database workflow  |

## Setup

**1. Install `age` and generate two keys.** Install it with `brew install age`, with `apt install age` on Debian or Ubuntu, or from a [release](https://github.com/FiloSottile/age/releases) after checking its hash. Each holder then does this on their own machine and never shares the result:

```sh
age-keygen -o backup-identity.txt   # prints the public key
chmod 600 backup-identity.txt
```

Store the identity file in a password manager, with a copy offline. Holders send only the public key (`age1...`). The two holders must be different people. One is the current maintainer, and the other should expect to outlast them.

**2. Enable the role.** Apply the migration, then connect as `postgres` with `psql`, because `\password` is a `psql` command:

```sql
ALTER ROLE backup_ro LOGIN;
\password backup_ro
SELECT rolbypassrls FROM pg_roles WHERE rolname = 'backup_ro';
```

The job works with either answer, and stops if the role could not see every row:

- `t`: Supabase allowed `BYPASSRLS`, so the role reads past row level security and the migration created no policies.
- `f`: Supabase refused it, so the migration gave this role a `backup_ro_read` policy on each table. Confirm `SELECT count(*) FROM pg_policies WHERE policyname = 'backup_ro_read'` returns 10, one per table. A later migration that adds a table raises that number.

**3. Create the private repo**, with `main` as its default branch and as few collaborators as possible, and copy in:

- `.github/workflows/backup.yml`, from the template, with both public keys filled in
- `backup/run-backup.sh`, `backup/check-freshness.sh`, `backup/copy-summary.awk` and `backup/verify-restore.sh`
- `backup/supabase-ca.pem`, the CA certificate from the Supabase dashboard's database settings
- a `.gitignore`, so a slip cannot commit a decrypted file or a key. The job commits only `backups/`, and this is for anyone working in a clone:

  ```gitignore
  .env
  .env.*
  .pgpass
  *.sql
  *.dump
  *.list
  *.agekey
  age-identity*
  backup-identity*
  keys.txt
  ```

**4. Add repo secrets.** Copy the host from the Supabase Connect panel's session pooler entry, and do not guess it.

| Secret                 | Value                                              |
| ---------------------- | -------------------------------------------------- |
| `BACKUP_PGHOST`        | Session pooler host                                |
| `BACKUP_PGUSER`        | `backup_ro.<project-ref>`                          |
| `BACKUP_PGPASSWORD`    | The password from step 2                           |
| `BACKUP_HEARTBEAT_URL` | Optional: a dead-man's switch URL, see "Scheduled" |

Never put the `postgres` password here. The job refuses any role except `backup_ro`.

**5. Prepare for the first run.** The job fails until `guild_config` has a row, so run `/setup` first. Until the reminder cron is live, set the repo variable `REMINDER_CHECK` to `off`, and delete that variable at launch, because it turns off the alert for a stopped reminder job.

**6. Run it by hand** once from the Actions tab, then do the restore drill below.

**Every quarter,** bump `PG_CLIENT_VERSION` to the newest 17.x, in both the private repo's workflow and `.github/workflows/db.yml`, and check for a new `age` release. Nothing updates these pins by itself, so security fixes arrive only this way.

## When a run fails

| Message                                 | Meaning and response                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Could not read the applied migrations   | `backup_ro` cannot read `supabase_migrations.schema_migrations`. No backup ran. As `postgres`, run `psql -v ON_ERROR_STOP=1 --single-transaction -f backup/grant-backup-role.psql`, then run the job again.                                                                                      |
| No applied migrations                   | The table is empty, so this project was not migrated with the Supabase CLI. No backup ran. Find out why before going on.                                                                                                                                                                         |
| A migration was applied during the dump | No backup was written, because its manifest could name the wrong versions. Run it again.                                                                                                                                                                                                         |
| Dated in the future                     | The newest successful `reminders` row is later than the database's clock. A real run cannot do that, and a trigger has refused it since migration 14, so treat this as possible tampering and follow the leak steps in [SECURITY.md](../SECURITY.md). Backups are fine and were committed first. |
| Row counts do not match                 | The dump disagrees with the live table. Nothing was committed. Investigate before retrying.                                                                                                                                                                                                      |
| A large unexplained drop                | See "What the drop check does not catch". Treat as possible data loss, and compare with `history.row_versions`. If it was expected, rerun by hand with the reason filled in.                                                                                                                     |
| Cannot read N tables                    | A migration added a table without granting it to `backup_ro`. Fix the migration.                                                                                                                                                                                                                 |
| Row level security hides N              | A table lacks a `USING (true)` policy for `backup_ro`, or has a restrictive one. Its rows would be missing from the dump, and a live count would hide that. Fix the policy.                                                                                                                      |
| Reminders last succeeded                | No successful run in 30 hours. Backups are fine and were committed first. Check the Vercel cron and `job_runs`. A post that refuses the bot can cause this: see "When a post refuses the bot".                                                                                                   |
| Version not found (from apt)            | The pinned client left both PGDG sources. No backup ran. Set `PG_CLIENT_VERSION` to a version PGDG still lists, 17.6 or later, in the workflow and in `db.yml`. Fix it same day.                                                                                                                 |

### When a post refuses the bot

One post that refuses the bot can fire "Reminders last succeeded" once. Each refused run fails, until the third in a row. That third run holds the event's reminders, succeeds, and lists the event in `held_event_ids`. Two failed runs can be enough to pass the 30-hour limit: with a last success at 14:00 on day 0 and failed runs at 14:00 and 16:00 on day 1, the 09:17 UTC check on day 2 fires. The 14:00 run that day holds the event.

The refused runs before the hold log `Thread refused the bot for event <id>`. Logs last one hour on Vercel Hobby, so by the time of the alert that line has probably gone. This finds the event instead:

```sql
SELECT id, name FROM public.events WHERE thread_refusals > 0 AND deleted_at IS NULL;
```

Give the bot access to the post again. Its held reminders go out on the next run, and the count returns to 0.

If the event's forum refuses the bot too, the log says `Forum refused the bot for event <id>` instead. Nothing is held and the count above is 0. Every run fails, and this alert fires at each backup, until the bot's permissions are fixed.

### What the drop check does not catch

The check compares row counts only. It fails when a table falls by more than 20% since the last good backup, for tables that had 5 rows or more. Smaller tables fail only on falling to zero. `public.interaction_claims` is exempt because its rows expire: the daily cron deletes those older than a day.

A mass overwrite that keeps the row count passes, and the bad data is backed up as normal. The defences there are `history.row_versions` and restoring from an older backup, so keep that history.

## Scheduled runs

GitHub's docs, as checked on 2026-11-04, disable scheduled workflows after 60 days without activity "in a public repository" and state no such rule for private ones. This repo is private and also commits daily, so it should keep running. Those docs do not say whether commits made with `GITHUB_TOKEN` count, so do not rely on that if the repo ever goes public. If a workflow is disabled, re-enable it with `gh workflow enable backup.yml`.

A stopped schedule cannot report its own failure, and GitHub may delay scheduled runs under load. So:

- On the first of each month, confirm the latest commit in the backups repo is under two days old.
- Optionally, set `BACKUP_HEARTBEAT_URL` to a dead-man's switch service that alerts when pings stop. The ping holds no data.

GitHub sends failure emails to whoever last changed the `cron` line. An incoming maintainer must edit that line themselves, or they will not hear about failures.

## Key loss or compromise

Git history keeps every old backup, and rotating a key does not re-encrypt any of them.

**One key lost.** The other holder can still decrypt. Generate a new key, replace the recipient in the workflow, and run the restore drill with the new key.

**Both keys lost.** Every existing backup is unrecoverable. Generate two new keys and run a new backup immediately.

**One key exposed.**

1. Generate a new key, replace the recipient and run a backup at once.
2. Treat every backup encrypted to the old key as readable by whoever holds it. That includes all of the repo's history, and it stays true after rotation.
3. If the repo may also have been read, assume member data was exposed. Create a new repo with only new backups, delete the old one, and tell the club's officers.

**Database password exposed.** Treat all data as read. The role cannot change app data, but it can stop reminders: an open session can hold the advisory lock the reminder job takes, and every run then fails until that session ends. A new password does not end a session that is already open, so do both, as `postgres` in `psql`:

```sql
\password backup_ro
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'backup_ro';
```

The second statement returns one `t` per session it ended. Then update `BACKUP_PGPASSWORD`. A backup running at that moment fails, so run it again by hand.

## Retention

Each backup is one new file, kept in Git history.

- Keep a full year. The history stays intact, so never force-push.
- Encrypted files do not compress against each other, so the repo grows by a full backup a day. Check its size monthly. The job fails if one file passes 95 MiB, because GitHub refuses files of 100 MiB.
- Each year, or when the repo passes about 800 MB, start a new repo and run a backup there. Then disable the old repo's schedule with `gh workflow disable backup.yml --repo <old repo>`, or both keep running. Delete the old repo 12 months later.
- Deleting the old repo is the only way to remove old data, including a former member's text. Until then, any key holder can read it.

## Restore drill

Before launch, every six months, and at every handoff. Each key holder does this with their own key, as an ordinary account on their own machine.

You need `age` and the Postgres 17 client tools, 17.6 or later (`brew install libpq`, then add its `bin` to `PATH`). The easiest server is a throwaway container, since `--rm` deletes the decrypted data with it:

```sh
docker run -d --rm --name backup-drill -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:5433:5432 postgres:17
sleep 5
docker exec backup-drill psql -U postgres -c 'CREATE ROLE restore_drill LOGIN'
docker exec backup-drill psql -U postgres -c 'CREATE DATABASE backup_scratch OWNER restore_drill'

bash backup/verify-restore.sh \
  --archive backups/<year>/backup-<stamp>.data.age \
  --manifest backups/<year>/backup-<stamp>.manifest.txt \
  --identity ~/path/to/backup-identity.txt \
  --scratch-url postgres://restore_drill@localhost:5433/backup_scratch

docker stop backup-drill
```

On an existing local server, create the same role and database with whichever account administers it. That is your own login on Homebrew, and `sudo -u postgres` on most Linux packages. Give the role a password with `--pwprompt`, and pass it to the script in `PGPASSWORD`. Afterwards unset that, then run `dropdb` as the administering account, because `restore_drill` cannot drop a database it is connected to. The server must not hold the app's roles.

The script accepts only a local server and an empty scratch database. It refuses a production-looking URL, a powerful role and a server with Supabase's schemas or the app's roles, and it never connects anywhere else.

Checklist:

- [ ] Used the newest backup, not one prepared for the drill
- [ ] Used my own key, with no help from the other holder
- [ ] The script printed `OK`
- [ ] Row counts look right for today, and `public.events` holds recent rows
- [ ] Scratch database gone, and no decrypted copy remains
- [ ] Noted the date and the backup's name somewhere the next maintainer will find it

## Real recovery

Into a new Supabase project, from a checkout of this repo. **Rehearse on staging first. Hosted Supabase has not run any of this.**

1. Turn reminders off if the bot can still run, and leave the old project untouched. Create the new project, and set `PGHOST`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` for its `postgres` role, with `PGSSLMODE=verify-full` and `PGSSLROOTCERT` set to its CA file.
2. Close the default privileges first. A new project may grant new tables to `anon`, `authenticated` and `service_role`, and a restore adds only the grants in the dump, so it would not remove those.

   ```sh
   psql -v ON_ERROR_STOP=1 -f supabase/migrations/20261104000001_default_privileges.sql
   ```

3. Create the role, because the restored grants name it:

   ```sh
   psql -v ON_ERROR_STOP=1 -f backup/create-backup-role.psql
   ```

4. Restore with the same filter as the drill. It skips `CREATE SCHEMA public`, which already exists, the policies, which step 5 recreates to suit this project, and the default privileges, which can name the platform's own roles and which step 2 has already set. Without that last part, the first such entry fails with `permission denied to change default privileges` and the whole restore rolls back, leaving no tables. The drill cannot show this, because it restores with `--no-privileges`.

   ```sh
   age --decrypt -i <identity> <backup>.data.age | pg_restore --list >restore-full.list
   grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (POLICY |SCHEMA - public |DEFAULT ACL )' restore-full.list >restore.list
   age --decrypt -i <identity> <backup>.data.age \
     | pg_restore --no-owner --single-transaction --use-list=restore.list -d "${PGDATABASE}"
   ```

5. Give the role its access back. This tries `BYPASSRLS`, or creates a `backup_ro_read` policy on every table with row level security, whichever this project allows. It works from the catalog, so a table added by any migration is covered and no migration needs rerunning. It stops with an error if any table is still closed to the role. It can safely run again.

   ```sh
   psql -v ON_ERROR_STOP=1 --single-transaction -f backup/grant-backup-role.psql
   ```

6. Record the migrations this backup already holds, then run the rest. The backup's manifest lists them in its `migration` lines. Do not mark anything else as applied: a migration newer than the backup would then never run, which breaks commands such as `/event create` and can leave a guard missing with no warning. Use a checkout of `main`, so it holds every version the manifest names. See SETUP Part 4 for the CLI version and what `--remote` does.

   ```sh
   supabase link --project-ref <new project ref>
   sed -n 's/^migration //p' <backup>.manifest.txt | while read -r version; do
     supabase migration repair --remote --status applied "$version" </dev/null
   done
   supabase db push --remote --dry-run
   ```

   **Expect:** the first line of output names the new project, not `local stack`, and the dry run lists only migrations newer than the backup. If it looks right, apply them, then run step 5's script again, because the table that records migrations did not exist the first time:

   ```sh
   supabase db push --remote
   psql -v ON_ERROR_STOP=1 --single-transaction -f backup/grant-backup-role.psql
   ```

7. Set the login and password, as in setup step 2.
8. Repoint the bot. In Vercel, set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to the new project's values and redeploy. In the backups repo, update `BACKUP_PGHOST`, `BACKUP_PGUSER`, `BACKUP_PGPASSWORD` and `backup/supabase-ca.pem`. Apply the same project settings the old one had.
9. Run the backup by hand and confirm it passes. Then compare the recorded migrations with the files, and do the schema check below. Delete `restore-full.list` and `restore.list`.

   ```sh
   diff <(ls supabase/migrations | cut -c1-14) \
     <(psql -X -A -t -c 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')
   ```

   **Expect:** no output.

### Schema check

A migration can be recorded as applied without having run, so the record alone does not show the guards are there. This lists every function, trigger, constraint, index and column. It does not compare grants or policies. Run it as `postgres` on the recovered project and on the staging project, once staging has the same migrations, saving each result to a file. Then `diff` the two files.

```sql
-- schema check
SELECT 'function' AS kind, p.oid::regprocedure::text AS name, md5(p.prosrc) AS detail
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'history')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
  )
UNION ALL
SELECT 'trigger', c.oid::regclass::text || '.' || t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history') AND NOT t.tgisinternal
UNION ALL
SELECT 'constraint', c.oid::regclass::text || '.' || k.conname, pg_catalog.pg_get_constraintdef(k.oid)
FROM pg_catalog.pg_constraint k
JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history')
UNION ALL
SELECT 'index', i.schemaname || '.' || i.indexname, i.indexdef
FROM pg_catalog.pg_indexes i
WHERE i.schemaname IN ('public', 'history')
UNION ALL
SELECT 'column', c.oid::regclass::text || '.' || a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY 1, 2;
```

**Expect:** the two files are the same. A line only in staging's file is something the recovered project is missing. Do not point the bot at it until you know why.

### What has been tested

| Step                         | Tested                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2-5, 7 (setting login)       | In the Database workflow's backup job, on plain Postgres 17, restoring as a role that is not a superuser, with default privileges modelled on Supabase's: grants, policies and triggers must match the source |
| 6 (the manifest's versions)  | In the same job: the manifest must list every migration. SQL stands in for the CLI when recording them                                                                                                        |
| 9                            | In the same job: a backup of the recovered server must match the restored row counts and versions, and the schema check must match and must notice a dropped constraint                                       |
| 1, 6 (CLI), 7 (password), 8  | **Not tested**, including `supabase migration repair`, a recovery from a backup older than the newest migration, and repointing the bot                                                                       |
| All steps on hosted Supabase | **Not tested**                                                                                                                                                                                                |

That job runs in CI on plain Postgres 17, on both the `bypassrls` and `policies` paths. It has not run on hosted Supabase.

## Undoing a change

No bot command reverses `/event close`, Mark done or `/event delete`, because nothing is really deleted and a mistake is rare. A maintainer does it by hand. Run these as `postgres`, in the Supabase SQL Editor or `psql`. Each one should report that it changed 1 row. `test/db/recovery-procedures.test.ts` runs this SQL, as the tables' owner on PGlite. It has not been run on hosted Supabase.

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

**Reopen a task marked done.** Reopen its event first if that is closed too, or this fails with `CF410`, even as `postgres`.

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

**Undelete one task.** Check first that its event is live, because this is not refused under a deleted event.

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

## Handoff

1. The incoming maintainer generates their own key, and it goes in `AGE_RECIPIENT_3`, so three holders can decrypt for now.
2. Wait for a backup encrypted to it. Its manifest lists three `recipient` lines.
3. The incoming maintainer passes the restore drill with that key **before the outgoing maintainer leaves**.
4. Only then does the new key replace the outgoing one, and `AGE_RECIPIENT_3` goes back to empty.

The outgoing key can still read every earlier backup, so rotate `BACKUP_PGPASSWORD` too, and start a new repo if trust has ended rather than just a term.

## Still to test on staging

None of this has run against Supabase. The role and row-security rules are tested on PGlite. The scripts are tested with stand-ins, and on plain Postgres 17 in the backup job, on both paths.

- [ ] Whether Supabase allows `ALTER ROLE backup_ro BYPASSRLS`, and which error it gives if not. A code other than `42501` stops the migration, which must then be adjusted.
- [ ] The real job through Supabase, on whichever path the project takes
- [ ] The pooler username form `backup_ro.<project-ref>`, and whether the pooler holds connections open against the role's limit of 3
- [ ] `sslmode=verify-full` through the session pooler with the dashboard's CA file
- [ ] Whether scheduled connections count as Supabase activity. Its docs list dashboard use, API calls and app requests but do not mention direct connections. A paused project makes the job fail, and the bot's daily use may be what keeps it awake.
- [ ] A restore drill by each real key holder
- [ ] The recovery steps above, on a staging project. That includes whether a dump there really holds `DEFAULT ACL` entries the owner cannot restore, as the test's model assumes, and whether `migration repair` creates its table on an empty project
- [ ] `supabase db push --remote` and `migration repair --remote` against a linked project, and the wording of their `Target:` line
- [ ] Whether `backup_ro` can read `supabase_migrations.schema_migrations` through the pooler after a real `db push`, and whether that table has row level security on hosted Supabase. The job stops if not
- [ ] Ending `backup_ro`'s sessions as `postgres` on hosted Supabase, and whether `pg_stat_activity` shows them under that name through the pooler
- [ ] The schema check between two hosted projects, and the SQL in "Undoing a change" in the SQL Editor
- [ ] A secret canary in a dry run, then a search of the Actions logs for it
