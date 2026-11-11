# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately and do not open a public issue.

- Open a private security advisory through GitHub's private vulnerability reporting, under the repository's Security tab. If that is not available, contact the repository's maintainers directly, and do not post details in a public channel.

Include what you found, how to reproduce it and what it could affect. Do not include real secrets or personal data in the report. This is a volunteer project, so there is no guaranteed response time.

## Supported versions

The project is in development and has no release yet. Only the latest commit on `main` is supported. After the first release, only the latest release will be.

## Security position

No system is unhackable, and this one makes no such claim. The aim is to keep the likely failures small and recoverable.

The project has not been deployed, so nothing below has been proved against real Discord, Vercel or Supabase. [docs/STAGING_CHECKLIST.md](docs/STAGING_CHECKLIST.md) lists what still has to be, and [README.md](README.md) gives the current status.

| Area              | Control                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Incoming requests | Signature checked on the raw body, old timestamps refused, allowlisted servers only                                        |
| Cron endpoint     | Protected by a shared secret, on the assumption that the URL is public                                                     |
| Authorization     | Deny by default, with each action checked against the stored row rather than client-supplied values                        |
| Database          | Server-side key only, row level security on, narrow grants with no `DELETE` or `TRUNCATE` on the bot's tables, row history |
| Outgoing messages | One send helper, text escaped when rendered, mentions limited to named users, managed channels only                        |
| Recovery          | Soft deletes, row history and encrypted daily backups                                                                      |

Some of this also depends on settings in the services' dashboards, which the repository cannot enforce. [docs/SETUP.md](docs/SETUP.md) lists them.

### Risks that remain

These remain even with every control above in place. [README.md](README.md) lists more.

- A Discord Administrator, or anyone who can manage roles, can give themselves access to the bot.
- A leaked bot token or database key bypasses this code, and rotating it does not undo what was done with it. Row history covers events and tasks only. A backup from before the leak also holds role bindings, forums and the reminder log, so it can show what they were. [Check for misuse](#2-check-for-misuse) covers the rest.
- Officer edits, completions and deletes record no actor. See [What can be attributed](#what-can-be-attributed).
- Autocomplete must answer in the HTTP response, so it cannot be deferred, and it is not claimed. Someone holding a captured signed autocomplete request can replay it inside the 5-minute window and read up to 25 current task or event choices that its sender could see. Getting one needs a compromised host or proxy. `/mytasks` and `/event delete` defer for this reason, so replaying those returns no content. Claiming autocomplete would cost a write per keystroke, so this is accepted.
- If the bot loses Send Messages across a server while it can still read the forums, reminders are held and the job goes green after three runs with nothing sent. [The runbook](docs/RUNBOOK.md#reminders-held-while-the-job-is-green) says how to spot it.
- A takeover of the maintainer's GitHub, Vercel, Supabase or Discord account defeats these controls, so two-factor authentication is required on all four.
- A flood of requests could exhaust free-tier limits and take the bot offline. This costs availability, not money.
- CI scans only commits still reachable from a ref, so a green run does not clear a secret that was force-pushed away. Rotate it.

### Limits of the pre-push hook

The hook reduces the chance of a leak but does not rule one out. It is a local control, and these bypass it:

- `git push --no-verify`
- a clone where `npm run hooks:install` was never run, or a checkout that does not contain `.githooks/`
- commits made through the GitHub web interface or API

The CI scan is the backstop for these. It runs the same path, author, tagger and message checks over every ref and tag, and fails on a tag that does not point to a commit, as the hook does. A committer address that is not a no-reply one is a warning in CI, not a failure.

The scan looks for known secret formats, numbers shaped like Discord IDs, email addresses and denied file types. It does not cover names: nothing detects a real member name, so that still depends on review. It cannot recognise a secret in an unknown format either.

## If a secret leaks

**Rotate first, then clean up.** Treat a secret as compromised from the moment it reached a remote, a log or a chat, even if it was removed seconds later. Removing it from Git does not revoke it.

### 1. Rotate

| Secret                | Action                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_BOT_TOKEN`   | Reset the token in the Discord Developer Portal, under the application's Bot page. Then follow [After a bot token leak](#after-a-bot-token-leak) |
| `SUPABASE_SECRET_KEY` | Create a new secret key in the Supabase dashboard, deploy it, then revoke the old one                                                            |
| `CRON_SECRET`         | Generate a new value with `openssl rand -hex 32` and update it in Vercel                                                                         |
| Database password     | Reset it in the Supabase dashboard. It belongs in a password manager only, never in Vercel                                                       |
| `BACKUP_PGPASSWORD`   | Run `\password backup_ro` in `psql` and update it in the backups repository                                                                      |
| age backup identity   | Generate a new identity, encrypt new backups to it, and treat backups readable with the old one as exposed                                       |

Then update the new value in every environment that uses it and redeploy. Confirm that the old value is refused.

**Delete the old deployments after a rotation.** A past deployment can keep the code and settings it was built with, and it still has its own URL. Standard Protection blocks the public from those URLs, but do not rely on it alone. In the Vercel dashboard, open the project's Deployments, select each deployment made before the rotation, and choose Delete from its menu. Keep the current one. This also removes those versions as rollback targets, so check that the current deployment works first. Never leave a rotated secret in a deployment that could be promoted again.

### 2. Check for misuse

- Review Discord audit logs, and Supabase and Vercel logs, from before the leak to the time of rotation.
- Compare data against row history. Restore from history or backup if needed. History covers `events` and `tasks` only.
- If member data may have been exposed, tell the affected people and the organisation's leadership.

#### After a database key leak

Rotating the key stops further use, but what it stored stays in place. Row history has no rows for these tables, so read them directly. The queries only read. Run them in the Supabase SQL editor, with `<start>` set to before the leak. They ran on PGlite with the repo's migrations, not on hosted Supabase.

**Roles, reminders and forums.** A leaked key can call the config functions directly, so it could bind its own role, which grants officer or admin, or turn reminders off. Compare each value with what the admins chose. If in doubt, re-run `/setup`, and fix forums and reminders with `/config`.

```sql
SELECT guild_id, officer_role_id, admin_role_id, reminders_enabled, timezone, version, updated_at
FROM public.guild_config
ORDER BY guild_id;

SELECT guild_id, channel_id, status, updated_at
FROM public.managed_channels
ORDER BY guild_id, channel_id;
```

`config_audit` is good evidence of what changed and when. The key can add rows through those functions but cannot rewrite or remove them. It does not cover a forum marked unavailable through `mark_channel_unavailable`. **Do not trust `actor_id` for the exposure window**, because the caller supplies it.

```sql
SELECT created_at, guild_id, action, old_values, new_values, version_after
FROM public.config_audit
WHERE created_at >= '<start>'
ORDER BY created_at;
```

**Burned reminders.** The key can claim a reminder and mark it skipped, so it never goes out and the run still reports success. A normal run skips a reminder only when a more urgent one is due on the same task and date, so look for skips with none more urgent. A reminder sent earlier does not clear a later skip.

Some rows here are harmless: a run that stopped before reaching the more urgent reminder, Discord refusing a reminder's text (`items_refused` in that run's `results`), or a stale claim closed because the task had finished or moved. Moving a task's due date with `/task edit` starts its reminders again. The original date stays burned, so tell that person directly if the date must not move.

```sql
SELECT log.task_id, log.kind, log.due_date, log.claimed_at
FROM public.reminder_log AS log
WHERE log.state = 'skipped'
  AND log.claimed_at >= '<start>'
  AND NOT EXISTS (
    SELECT 1
    FROM public.reminder_log AS other
    WHERE other.task_id = log.task_id
      AND other.due_date = log.due_date
      AND other.kind > log.kind
      AND other.state <> 'skipped'
  )
ORDER BY log.claimed_at;
```

The `<start>` filter has a blind spot. A skip leaves `claimed_at` unchanged and no column records when it happened. The key can read claim tokens, so it can skip a reminder claimed before `<start>`, such as a held one. To include those, set an earlier date in this query.

**Job runs.** The key cannot write `job_runs` directly or date a run in the future. It can still call `begin_job_run` and `finish_job_run`, which closes that day's slot with nothing sent. A test confirmed the next run then returns `duplicate`. This stops at rotation, as the next day's slot opens as usual. Look for a success outside the hours after the 14:00 and 16:00 UTC crons, or on a day when reminders were due and none arrived. Empty `results` prove nothing alone, because a quiet day looks the same.

```sql
SELECT job_name, status, started_at, finished_at, error, results
FROM public.job_runs
WHERE started_at >= '<start>'
ORDER BY started_at;
```

**Event state.** The key can raise `thread_refusals`, which makes a run treat an event's waiting reminders as held, or mark a post missing. A send that lands clears the count. `/event link` gives an event a post again.

```sql
SELECT guild_id, channel_id, id, thread_status, thread_refusals, updated_at
FROM public.events
WHERE deleted_at IS NULL AND (thread_refusals > 0 OR thread_status <> 'active')
ORDER BY guild_id, channel_id;
```

**Quotas.** The key can add `task_reassignments` rows naming another officer, or new tasks under another `created_by`, so that officer hits the limit of 50 in 24 hours. That clears as the window passes. `created_by` in the window is not proof of who made a task.

#### After a bot token leak

Unverified on a real app: Discord's documentation lists `interactions_endpoint_url` as editable through `PATCH /applications/@me`, for the app of the requesting bot. This repo has not confirmed that a bot token is accepted for it, or that a token reset leaves the field unchanged. Assume both until [the staging test](docs/RUNBOOK.md#still-to-test-on-staging) says otherwise. A redirect could forward requests unchanged to the real endpoint, so members might notice nothing.

After resetting the token:

1. In the Developer Portal, on the application's General Information page, check that the Interactions Endpoint URL is yours. Check the description, the install settings and any other URL on the app's pages too, and put back anything changed.
2. Run `npm run commands:register -- <guild-id>` for each server, with the new token. This replaces the server's whole command list, undoing any change made to it. It does not touch global commands, which this project never registers, so look in Discord's command picker for duplicates.
3. If the URL was changed, treat every interaction received in that time as exposed: the member and role IDs, the text typed, and the interaction tokens. Unverified: how long those tokens stay valid. Discord's documentation gives 15 minutes.

#### What can be attributed

This matters most after a stolen officer account, when you need to know which account to remove. No actor column is added for this, by decision.

| Action                                  | What records who did it                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings and role changes               | `config_audit.actor_id`                                                                                                                            |
| Creating an event                       | `events.created_by`                                                                                                                                |
| Assigning a task                        | `tasks.created_by`, and the public notice names who gave it                                                                                        |
| Changing a task's person                | `task_reassignments.actor_id`, and the public notice names who gave it                                                                             |
| Closing or deleting an event            | A note in the event's post names them, if it has a post and the note landed. No database column records it                                         |
| Linking a post with `/event link`       | `events.created_by` if it made a new event. Attaching to an existing one records nothing. Row history shows the change and the time, with no actor |
| Editing a task's text or date           | Nothing. Row history shows the old values and the time, with no actor                                                                              |
| Marking a task done, or deleting a task | Nothing. Row history shows the change and the time, with no actor                                                                                  |

These columns are as reliable as the key: after a database key leak, none of them is proof for that window. A post can be edited or deleted by anyone with that right in Discord. Logs hold failures only, and Hobby keeps them for one hour. Unverified: Discord's audit log is not expected to record slash commands.

### 3. Clean up

Do this only after rotating.

- Remove the secret from history on a fresh clone, for example with `git filter-repo`. Rewrite every ref that can reach it: branches, tags and notes.
- Force-push the rewritten branches, tags and notes after telling any collaborators, and have them re-clone rather than pull.
- `refs/pull/*` refs are read-only and keep the old commits. Ask GitHub Support to remove them and purge cached views if the commit was ever visible to others.
- Forks keep their own copies and a rewrite does not reach them. Find any forks and ask their owners to delete or clean them, or ask GitHub Support for help.
- Confirm that history is clean with both configurations:

```sh
.tools/gitleaks git . --config .gitleaks.toml --redact --ignore-gitleaks-allow --log-opts="--all -m --text --no-color"
.tools/gitleaks git . --config .gitleaks-custom.toml --redact --ignore-gitleaks-allow --log-opts="--all -m --text --no-color"
```

### 4. Learn from it

Record what leaked, how and when, without repeating the value. If the scanner missed it, add a rule and a canary in `scripts/test-gitleaks-rules.sh`.
