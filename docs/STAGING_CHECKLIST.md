# Smoke checks

Run these on the private test server from [SETUP.md](SETUP.md), before the club's server is added, and again after a risky change. Use made-up names and data. If a result differs, write down what you saw, and fix it or decide to accept it before going on.

## Before you start

You need a second Discord account with no bot role (the member), and Vercel's Logs open, because Hobby keeps them for one hour. In a terminal, set these, pasting `bot_app`'s connection string and then the cron secret. `read -rs` keeps them off the screen and out of your shell history. The cron is run by hand with the `curl` line.

```sh
URL=https://<name>.vercel.app
read -rs BOT_URL
read -rs CRON
```

```sh
curl -i -H "Authorization: Bearer $CRON" "$URL/api/cron/reminders"
```

A run that succeeds closes that day's slot, and later runs in it answer `ok` and do nothing, so a run by hand counts only if it adds a row. A reminder claimed less than 2 minutes ago is left alone, so wait 2 minutes between runs. As the owner, in Neon's SQL editor, the first query reads the rows. The second opens the slot again: use it only while the club's server is not on.

```sql
SELECT job_name, status, started_at, error, results
FROM public.job_runs ORDER BY started_at DESC LIMIT 6;

UPDATE public.job_runs SET started_at = started_at - interval '1 day'
WHERE status = 'succeeded' AND started_at > now() - interval '1 day';
```

## Checks

1. **Ping.**
   - Do: run `/ping`, and again after 15 quiet minutes.
   - Expect: `Pong!`, only to you, both times.
2. **Setup.**
   - Do: run `/setup` as the member. Then, as an Administrator, run it with the five test roles and click Confirm.
   - Expect: the member gets `You can't do that, or it doesn't exist.` You get `Saved.` and the five roles, with E-board as `E-board (also admin)`.
3. **Config.**
   - Do: run `/config` and add the test forum in **Add a managed forum**.
   - Expect: `Added`, and the panel lists the forum and the five roles. Nobody is notified.
4. **Create an event.**
   - Do: run `/event create` with a made-up name and date, and the member in `budget`.
   - Expect: `Created ...`, and a post whose overview has a checklist with the member on Budget Sheet and three buttons. Nobody is notified.
5. **Assign a task and mark it done.**
   - Do: in the post, `/task assign` the member. As the member, click **Mark done**.
   - Expect: one message in the post that pings only the member, then a private `Marked done: ...`, and the overview updates.
6. **Budget Sheet hand-off.**
   - Do: as the member, click **Budget Sheet done** twice.
   - Expect: one message, `@Treasury Committee Budget Sheet for ... is done.`, and the role is notified once. The second click says it is already done.
7. **Engage post hand-off.**
   - Do: `/event assign step:Engage post` the member, then as the member click **Engage post done**.
   - Expect: one message, `@Marketing Committee Engage post for ... is up.`
8. **Food pickup before Budget approved.**
   - Do: before anyone clicks **Budget approved**, run `/event pickup time:5:30 PM` and `/event assign step:Food pickup` with the member.
   - Expect: both work, the overview ticks Food pickup, and the member's `/mytasks` lists it.
9. **Pickup times as Discord timestamps.**
   - Do: read the pickup time in the overview, the `/event pickup` reply, `/mytasks` and a pickup reminder, on a device set to another time zone too.
   - Expect: a time in each reader's own zone, 5:30 PM in the server's zone, and never raw `<t:...>` text.
10. **Hostile text.**
    - Do: assign a task described as `@everyone @here **bold** <@&ROLE_ID> https://example.com`, with a real role ID from the test server. Then try `[Log in](https://example.com)` and a server invite link, as a description and as an event name.
    - Expect: nobody but the assignee is notified, and the text shows as typed, with no formatting, pills or clickable link. The masked link and the invite are refused, and nothing is made.
11. **A deleted post.**
    - Do: delete an event's post, change one of its tasks, and run `/event status`. Then make a post by hand and run `/event link` inside it, choosing that event.
    - Expect: the status says the post `can no longer be found`. After the link, the new overview shows the event's tasks.
12. **`/event create` that Discord does not confirm.** This cannot be caused on purpose, so check it the first time it happens.
    - Do: when a reply says `Discord didn't confirm the post, so it may have been made.`, run the same `/event create` again.
    - Expect: no second post. The reply says a post may already exist and to run `/event link` inside it, or to make the post and run `/event link` there.
13. **A locked post.**
    - Do: lock the post of an event with a task reminder due, and run the cron by hand. Unlock it, wait 2 minutes, and run it again.
    - Expect: the first run is `failed` with `channels_inaccessible`, Logs say `Thread refused the bot for event <id>`, and other events' reminders still go out. The second run sends that reminder with its ping.
14. **Close and delete.**
    - Do: `/event close` one event, and `/event delete` another and click Confirm.
    - Expect: each post gets one line naming who did it, the closed overview says so, and neither event gets reminders again.
15. **One cron run, then a rerun.**
    - Do: with a task due tomorrow and the slot open, run the cron by hand, wait 2 minutes, and run it again.
    - Expect: one reminder in the post, pinging the person, with a Mark done button. One new `succeeded` row for each job. The second run answers `ok` and adds no row.
16. **The kill switch.**
    - Do: with a task due and the slot open, click **Turn reminders off** in `/config`, run the cron by hand, then click **Turn reminders on**.
    - Expect: a new `succeeded` row and nothing sent. The panel says turning them on after the day's run does not reopen it, and gives the run's time in your own zone. Reminders resume with the next day's run.
17. **The recovery run.**
    - Do: before the morning run, set a wrong `DISCORD_BOT_TOKEN` in Vercel and redeploy. After it, and before the recovery run, put the right one back and redeploy. [RUNBOOK.md](RUNBOOK.md#when-it-runs) gives both times.
    - Expect: a `failed` reminders row from the morning run, a `succeeded` one from the recovery run, and the reminder sent with its ping.
18. **Neon cold start.**
    - Do: leave the bot idle until Neon's console shows the compute as suspended, then run `DATABASE_URL="$BOT_URL" bun scripts/neon-cold-start.ts`. Let it suspend again and run `/config`.
    - Expect: `One read took <n> ms, under the 2200 ms deadline.`, and `/config` answers without "did not respond". Write down the time.

Clear the terminal's values with `unset BOT_URL CRON` when you finish.

## Settings to confirm

- [ ] GitHub, Discord, Vercel and Neon each use a passkey or security key, with recovery codes saved.
- [ ] Vercel's settings are in Production only, and `DISCORD_BOT_TOKEN`, `DATABASE_URL` and `CRON_SECRET` are of type Secret.
- [ ] `DATABASE_URL` is `bot_app`'s string. The owner's string is in no Vercel project and no GitHub secret.
- [ ] Deployment Protection is Standard Protection, no Protection Bypass for Automation exists, and Discord's endpoint is the production domain.
- [ ] Only `main` deploys: a pushed branch makes no deployment.
- [ ] Settings > Cron Jobs lists `/api/cron/reminders` twice, the firewall rules are active, and usage notifications are on.
- [ ] The build log shows Bun installing from `bun.lock` with no changes to it.
- [ ] In Neon, only the owner and `bot_app` can log in, and the Data API and Neon Auth are off. `psql "$BOT_URL&sslrootcert=system" -c 'TRUNCATE public.job_runs;'`, with `psql` 16 or later, says `permission denied`.
- [ ] The Discord app has Public Bot off, User Install off and Install Link set to None.
- [ ] Few people hold Administrator, Manage Roles or the five bound roles.
- [ ] The first manual export is taken, as in [RECOVERY.md](RECOVERY.md#a-manual-export).
