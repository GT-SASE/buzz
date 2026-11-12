# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately and do not open a public issue.

- Open a private security advisory through GitHub's private vulnerability reporting, under the repository's Security tab. If that is not available, open an issue that asks a maintainer to get in touch, with no details in it, and do not post details in any other public channel.

Include what you found, how to reproduce it and what it could affect. Do not include real secrets or personal data in the report. This is a volunteer project, so there is no guaranteed response time.

## Supported versions

The repository is public, and the project is in development with no release yet. Only the latest commit on `main` is supported. After the first release, only the latest release will be.

## Security position

No system is unhackable, and this one makes no such claim. The aim is to keep the likely failures small and recoverable.

The bot runs on a private test server, and the Neon setup has not yet been tried live. So nothing below has been proved against Neon, and only part of it against real Discord and Vercel. [docs/STAGING_CHECKLIST.md](docs/STAGING_CHECKLIST.md) lists what still has to be, and [README.md](README.md) gives the current status.

| Area              | Control                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Incoming requests | Signature checked on the raw body, old timestamps refused, allowlisted servers only                 |
| Cron endpoint     | Protected by a shared secret, on the assumption that the URL is public                              |
| Authorization     | Deny by default, with each action checked against the stored row rather than client-supplied values |
| Database          | One narrow login role, grants with no `DELETE` or `TRUNCATE` for the bot, row history               |
| Outgoing messages | One send helper, text escaped when rendered, mentions limited to named users, managed channels only |
| Recovery          | Soft deletes, row history, Neon's point-in-time restore and occasional private exports              |

Some of this also depends on settings in the services' dashboards, which the repository cannot enforce. [docs/SETUP.md](docs/SETUP.md) lists them.

### Risks that remain

These remain even with every control above in place. [README.md](README.md) lists more.

- A Discord Administrator, or anyone who can manage roles, can give themselves access to the bot.
- A leaked bot token or `DATABASE_URL` bypasses this code, and rotating it does not undo what was done with it. Row history covers events, tasks, event steps and their people, settings, managed forums and setup drafts. It does not cover the reminder log, job runs or reassignment counts, but a Neon branch restored to before the leak holds them, so it can show what they were. [Check for misuse](#2-check-for-misuse) covers the rest.
- Officer edits, completions and deletes record no actor. See [What can be attributed](#what-can-be-attributed).
- Autocomplete must answer in the HTTP response, so it cannot be deferred, and it is not claimed. Someone holding a captured signed autocomplete request can replay it inside the 5-minute window and read up to 25 current task or event choices that its sender could see. Getting one needs a compromised host or proxy. `/mytasks` and `/event delete` defer for this reason, so replaying those returns no content. Claiming autocomplete would cost a write per keystroke, so this is accepted.
- If the bot loses Send Messages across a server while it can still read the forums, reminders are held and the job goes green after three runs with nothing sent. [The runbook](docs/RUNBOOK.md#reminders-held-while-the-job-is-green) says how to spot it.
- A takeover of the maintainer's GitHub, Vercel, Neon or Discord account defeats these controls, so two-factor authentication is required on all four.
- A flood of requests could exhaust free-tier limits and take the bot offline. This costs availability, not money.
- CI scans only commits still reachable from a ref, so a green run does not clear a secret that was force-pushed away. Rotate it.

### Limits of the pre-push hook

The hook reduces the chance of a leak but does not rule one out. It is a local control, and these bypass it:

- `git push --no-verify`
- a clone where `pnpm hooks:install` was never run, or a checkout that does not contain `.githooks/`
- commits made through the GitHub web interface or API

The CI scan is the backstop for these. It runs the same gitleaks scan over every commit on every ref, with `.gitleaks.toml`: gitleaks' default rules plus rules for Discord bot tokens, Discord webhook URLs and passwords in Postgres connection strings. GitHub secret scanning and push protection also cover the public repository.

The scan looks for known secret formats. It does not check file types or commit identities, so keep `.env` files and database dumps out of the repository, and set `git config user.email` to your GitHub noreply address. It does not cover names or Discord IDs: nothing detects a real member name or ID, so those still depend on review. It cannot recognise a secret in an unknown format either.

## If a secret leaks

**Rotate first, then clean up.** Treat a secret as compromised from the moment it reached a remote, a log or a chat, even if it was removed seconds later. Removing it from Git does not revoke it.

### 1. Rotate

| Secret                                | Action                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                   | Reset the token in the Discord Developer Portal, under the application's Bot page. Then follow [After a bot token leak](#after-a-bot-token-leak)                                                                                                                                                                          |
| `DATABASE_URL` (`bot_app`'s password) | Generate a new password, for example with `openssl rand -hex 32`. As the owner, in Neon's SQL editor or `psql`, run `ALTER ROLE bot_app PASSWORD '<new password>';`. Put the new password into `DATABASE_URL` in Vercel and redeploy. The old password stops working at once, so the bot fails until the redeploy is live |
| `CRON_SECRET`                         | Generate a new value with `openssl rand -hex 32` and update it in Vercel                                                                                                                                                                                                                                                  |
| The owner role's password             | Reset it for that role in the Neon console. Check this in the dashboard. It belongs in a password manager only, never in Vercel                                                                                                                                                                                           |

Then update the new value in every environment that uses it and redeploy. Confirm that the old value is refused.

A new password does not close connections that are already open. To close any left from the leaked one, run this as the owner.

```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'bot_app';
```

**Delete the old deployments after a rotation.** A past deployment can keep the code and settings it was built with, and it still has its own URL. Standard Protection blocks the public from those URLs, but do not rely on it alone. In the Vercel dashboard, open the project's Deployments, select each deployment made before the rotation, and choose Delete from its menu. Keep the current one. This also removes those versions as rollback targets, so check that the current deployment works first. Never leave a rotated secret in a deployment that could be promoted again.

### 2. Check for misuse

- Review Discord audit logs, Vercel logs and what Neon's console shows of the project's activity, from before the leak to the time of rotation.
- Compare data against row history. Restore from history or with Neon's point-in-time restore if needed, as [docs/RECOVERY.md](docs/RECOVERY.md) describes. History covers `events`, `tasks`, `event_steps`, `event_step_assignees`, `guild_config`, `managed_channels` and `setup_drafts`.
- If member data may have been exposed, tell the affected people and the organisation's leadership.

#### After a `DATABASE_URL` leak

Rotate `bot_app`'s password as above. The login cannot delete rows, read `history`, undelete a row or reopen a closed event, but it can change events, tasks, settings and reminder state through the bot's functions. Compare `guild_config` and `managed_channels` with `history.row_versions` and `config_audit` from before the leak, fix anything wrong with `/setup` or `/config`, and check that the next `reminders` row in `job_runs` succeeds. Do not trust `actor_id` or `created_by` for that window.

#### After a bot token leak

Reset the token as above. Then check on the app's General Information page in the Developer Portal that the Interactions Endpoint URL and the app's other settings are yours, and run `pnpm commands:register <guild-id>` for each server to put the command list back.

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

These columns are as reliable as the database login: after a `DATABASE_URL` leak, none of them is proof for that window. A post can be edited or deleted by anyone with that right in Discord. Logs hold failures only, and Hobby keeps them for one hour.

### 3. Clean up

Do this only after rotating.

- Remove the secret from history on a fresh clone, for example with `git filter-repo`. Rewrite every ref that can reach it: branches, tags and notes.
- Force-push the rewritten branches, tags and notes after telling any collaborators, and have them re-clone rather than pull.
- `refs/pull/*` refs are read-only and keep the old commits. Ask GitHub Support to remove them and purge cached views if the commit was ever visible to others.
- Forks keep their own copies and a rewrite does not reach them. Find any forks and ask their owners to delete or clean them, or ask GitHub Support for help.
- Confirm that history is clean:

```sh
.tools/gitleaks git . --config .gitleaks.toml --redact --ignore-gitleaks-allow --no-banner --log-opts="--all -m --text --no-color"
```

### 4. Learn from it

Record what leaked, how and when, without repeating the value. If the scanner missed it, add a rule to `.gitleaks.toml` and check that it fires on a sample built at runtime, never a real value.
