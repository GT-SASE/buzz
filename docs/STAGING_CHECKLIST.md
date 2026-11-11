# Staging checklist

The tests in this repo use stand-ins for Discord, Vercel and Supabase. Everything here can only be proved against the real services. None of it has been run yet. Expected results come from the code and those stand-ins, so a real error code or message may differ. When it does, record what you saw.

Do this on the test setup from [SETUP.md](SETUP.md), with made-up data. Tick an item only when you have seen the result yourself. If you accept a failure, write down why.

The last section lists settings to confirm. Repeat that section on production.

## Before you start

Set these in the terminal. `read -rs` waits for you to paste a value, and keeps it out of your shell history and off the screen. Paste the test project's `sb_publishable_` key, then its `sb_secret_` key, then its cron secret, pressing Enter after each.

```sh
URL=https://<name>.vercel.app
SUPABASE=https://<test-project-ref>.supabase.co
read -rs PUBLISHABLE
read -rs SECRET_KEY
read -rs CRON
```

You need a second Discord account, called the member here, with no bot role. You also need a task on an event, made with `/event create` and `/task assign`.

Logs last one hour on Hobby, so open Vercel's Logs while you test.

### Running the cron by hand

Where an item says to run the cron by hand, it means this:

```sh
curl -i -H "Authorization: Bearer $CRON" "$URL/api/cron/reminders"
```

Each job, `reminders` and `health_check`, can succeed once per slot. A slot runs from 14:00 UTC to the next 14:00 UTC. After a success, a later run in that slot does nothing and still answers 200 `ok`. A failed run does not close the slot. So `ok` proves nothing, and a by-hand run after the daily cron usually tests nothing.

Before a by-hand run, check the slot in the SQL Editor. A row means that job's slot is closed.

```sql
SELECT job_name, status, started_at, results
FROM public.job_runs
WHERE status = 'succeeded'
  AND started_at >= date_trunc('day', now() - interval '14 hours', 'UTC') + interval '14 hours';
```

To open the slot, wait for the next 14:00 UTC, or on the test project only, move the slot's rows back a day. This keeps the rows but makes their dates false. A moved row can be over 26 hours old, so a later health check row can show `reminders_stale: 1`, with `no recent successful run` in Logs, and that is not a fault. Moved rows also spoil the one-row-a-day evidence in "Each cron really fires". Never do it on production.

```sql
UPDATE public.job_runs
SET started_at = started_at - interval '1 day'
WHERE status = 'succeeded'
  AND started_at >= date_trunc('day', now() - interval '14 hours', 'UTC') + interval '14 hours';
```

The daily crons can close the slot while you test. To stop that, use Settings > Cron Jobs > Disable Cron Jobs on the test project, and turn them back on afterwards.

After a by-hand run, read the result. A run counts as evidence only if it added a new row.

```sql
SELECT job_name, status, started_at, error, results
FROM public.job_runs ORDER BY started_at DESC LIMIT 6;
```

A reminder tried less than an hour ago is left alone. That run is `failed`, with `fresh_claims_waiting` in `results`, unless the event is already held. When a test needs a reminder tried again, wait over an hour between runs.

## Discord's real payloads

- [ ] **Discord accepts the signed endpoint.**
  - Do: save the Interactions Endpoint URL on the test app.
  - Success: it saves, and stays set a day later.
  - If it fails: follow Part 6 of the setup guide. If it saved and later vanished, Discord's routine checks failed, so check Logs for 500s around that time.

- [ ] **`context` and `authorizing_integration_owners` arrive as the code expects.**
  - Do: run `/ping` in the test server. The endpoint answers only if `context` is 0 and `authorizing_integration_owners["0"]` equals the guild ID.
  - Success: `Pong!`.
  - If it fails: Discord shows a failure and the request gets a 403 in Logs. Check `ALLOWED_GUILD_IDS` first. If that is right, the check in `isAllowedGuildInteraction` does not match real payloads and must be fixed before launch. Do not loosen it to get a reply without knowing what Discord sent.

- [ ] **The server owner's payload works.**
  - Do: as the server owner, holding no role with Administrator, run `/setup`. Also run `/config`.
  - Success: both work. Owners hold every permission, so `member.permissions` should include Administrator.
  - If it fails: the owner gets `You can't do that, or it doesn't exist.` Record what you saw, and fix `parseActor` before launch. For now, an owner can give themselves a role with Administrator.

- [ ] **A channel overwrite cannot give someone the Administrator bit.** `member.permissions` includes channel overwrites, and `/setup` trusts that bit.
  - Do: Discord's settings do not offer Administrator on a channel, so use the API. On the test server only, give the bot a temporary role with Administrator. Then send a `PUT` to `/api/v10/channels/<channel-id>/permissions/<member-id>` on Discord's API host, with the bot's token and the body `{"type":1,"allow":"8","deny":"0"}`. Run `/setup` as the member in that channel.
  - Success: Discord refuses the write, or the member gets the fixed refusal. Remove the overwrite and the temporary role either way.
  - If it fails: the member reaches `/setup`, which means Bindings can be gained through a channel. Do not launch. The Administrator check must then read the member's guild-level permissions instead.

- [ ] **`resolved.channels[id].app_permissions` is present, and describes the chosen forum.**
  - Do: on `staging` only, add this line after `const resolved = ...` in `addForum` in `src/handlers/config.ts`, and deploy: `console.warn("resolved app_permissions:", resolved?.appPermissions !== undefined);`. Create a second forum where the bot has View Channel but not Send Messages. Run `/config` from a channel where the bot has full access, and try to add that forum. Then remove the line.
  - Success: the panel names the missing permission, and Logs show `true` or `false`. Write the answer in record 3. With `false`, each add relies on the overwrite calculation, which still has to give the right answer here.
  - If it fails: the forum is added although the bot lacks access, so `app_permissions` is describing another channel. Stop using it in `botPermissionsIn`.

- [ ] **Forum permission names match.**
  - Do: compare the names in the panel's message (View Channel, Send Messages, Send Messages in Threads) with the labels on a forum's permissions screen.
  - Success: a person can tell which switch to turn on.
  - If it fails: if the forum says Create Posts instead, change the text in `REQUIRED_PERMISSIONS` so it shows Discord's label.

- [ ] **`GET @original` returns the ephemeral flag, and soon enough.**
  - Do: run `/config` several times, including after a few idle minutes. The bot reads its own deferred reply before editing it, with retries after a 404 at about 250, 500 and 1000 ms.
  - Success: the panel appears every time.
  - If it fails: a reply stuck on "thinking", with `DiscordClientError kind=not_ephemeral` or `status=404` in Logs. Discord's reply differs from what `editEphemeralReply` expects, so fix that or extend the retries.

- [ ] **`waitUntil` keeps the work running after the acknowledgement.**
  - Do: run `/config` and `/mytasks`.
  - Success: the "thinking" reply fills in. No local test can show this.
  - If it fails: it stays on "thinking", and nothing appears in Logs. Check that `api/interactions.ts` still uses `waitUntil` from `@vercel/functions`. All deferred commands are broken until this works.

- [ ] **`/setup` refuses `@everyone` and managed roles.**
  - Do: run `/setup` and choose `@everyone` for each role in turn. Repeat with a role an integration manages, such as the role another bot brings.
  - Success: `The officer role can't be @everyone...`, or the matching message for a managed role, and no Confirm button.
  - If it fails: stop and fix `bindingProblem`. The database also refuses `@everyone`, but a managed role has no such backstop.

- [ ] **`/setup` is hidden from others, and the gate works anyway.**
  - Do: as the member, look for `/setup`. Then as an admin, use Server Settings > Integrations to allow it for the member, and run it as the member.
  - Success: hidden at first, then the fixed refusal. Remove the override.
  - If it fails: the gate is wrong, which is critical. Do not launch.

- [ ] **Ordinary members and officers get what the tiers say.**
  - Do: as the member, try `/config`, `/task assign` and clicking another person's Mark done button. Then give the member `Test Officer` and repeat, then remove the role and click a button on a panel opened while holding it.
  - Success: refused as a member, allowed as an officer except `/config`, and refused again at once after losing the role.
  - If it fails: check `COMMAND_POLICY` in `src/lib/permissions.ts` against record 4.

## Message safety

Use this as a task description. Replace the placeholders with real IDs copied from the test server.

```text
**bold** _slant_ ~~struck~~ ||spoiler|| `code` # heading > quote -# small @everyone @here <@&ROLE_ID> <@OTHER_MEMBER_ID> <#CHANNEL_ID> </ping:1> https://example.com/login www.example.com
```

- [ ] **Escapes render as plain text on desktop and mobile.**
  - Do: assign a task with that text. View the post, `/mytasks`, a reminder and `/task edit`'s reply, on desktop and on the phone app.
  - Success: all the symbols show as typed, with no formatting, pills or styled mentions.
  - If it fails: add the construct to `escapeUserText` in `src/discord/safe-text.ts` with a test. Take screenshots only with made-up data.

- [ ] **URLs are not clickable, and show no preview.**
  - Do: on the same messages, tap and click each URL on desktop and on the phone. Note what copying gives. `/mytasks` matters here, because it is an edit of a deferred reply, and whether Discord honours `flags: 4` on that edit is unverified.
  - Success: nothing opens, there is no preview, and the address reads as typed. Record how it copies in record 5.
  - If it fails: the plain URL allowance in record 5 depends on this. Refuse URLs in task text until it is fixed.

- [ ] **Masked links and invites are refused.**
  - Do: try `[Log in](https://example.com/login)` as a description, then a real server invite link.
  - Success: the reply says these aren't allowed, and no task is made.
  - If it fails: check `containsInviteOrMaskedLink`.

- [ ] **Hostile text pings nobody.**
  - Do: have the other member and a role holder watch for notifications while you send the text above. Check the task notice, a reminder, an event post, a `/task edit` notice and every private reply and follow-up.
  - Success: only the assignee is notified. No role, `@everyone` or `@here` ping happens, including on follow-ups. This also shows whether Discord accepts `allowed_mentions` with `parse: []` and a `users` list, which every notice uses. If it did not, notices would fail with a 400 and code 50035 in Logs.
  - If it fails: this is the worst failure on this list. Turn reminders off and do not launch. All message bodies must go through `src/discord/outbound.ts`.

- [ ] **Length limits match how Discord counts.**
  - Do: create text at each limit with emoji, such as a task description full of them.
  - Success: Discord accepts anything the bot accepts. The code counts UTF-16 units, the stricter measure.
  - If it fails: lower the limit in `DISCORD_LIMITS` to match.

- [ ] **AutoMod refusals are understood.**
  - Do: add a server AutoMod rule that blocks a test word, then assign a task, create an event and let a reminder run with that word in the text.
  - Success: a clear reply, and other tasks in the same reminder run still go out. Note the error code in Logs. The code expects 200000.
  - If it fails: update `DiscordErrorCode` with the real code, and check that one blocked task cannot stop the others.

- [ ] **A title blocked by AutoMod.**
  - Do: with the same rule on, run `/event create` with the test word only in the event's name.
  - Success: the reply says `This server's AutoMod blocked the post, so try different wording.`, and that the event and its tasks are kept. No post appears. Note the error code in Logs. The code expects 200001 for a title. Then make a post by hand under different wording, run `/event link` inside it and choose this event in the event option. The event now has that post.
  - If it fails: a reply that says only `Discord refused to create the post.` means the real code differs, so update `TITLE_BLOCKED` in `src/handlers/event.ts`.

- [ ] **Crafted `custom_id` values do nothing.**
  - Do: this needs a modified client or a signed request, so use the temporary key in the attack section to send a component payload for the test server's ID with a bad `custom_id`.
  - Success: the fixed refusal.
  - If it fails: check `customIdTarget` in `src/handlers/router.ts`.

## Forums and posts

- [ ] **Posting into an archived thread works without Manage Threads.**
  - Do: archive an event's post by hand, then run `/task assign` on that event and let a reminder go out for it. Repeat with a locked post.
  - Success: the message posts and the thread reopens. A locked post gives a clear failure, and the officer is told that the person was not mentioned.
  - If it fails: decide whether to grant Manage Threads. Record the decision in a new record, because the plan has it off.

- [ ] **A mentioned member who can't view the forum.**
  - Do: take View Channel away from the member on a managed forum, then run `/task assign` for them. Watch their account for a notification.
  - Success: the task saves. The reply says the person `was mentioned in the event's post`, not pinged, and warns that they `can't view this event's forum, going by its permissions`. `/mytasks` still lists the task for the member. Repeat with `/task edit` to reassign a task to them. Note whether Discord notified the member anyway. Let a reminder go out too. The bot marks it sent whether or not they were notified.
  - If it fails: if no notification arrives, a silent miss is more serious than the warning suggests, so decide whether the warning should say that plainly. No warning at all means `reachWarning` in `src/tasks/notify.ts` could not settle the permissions, because a check that cannot finish stays silent. The server owner gets a needless warning if shut out on paper.

- [ ] **Changing a task in an archived post.** Discord's docs say messages can't be edited in archived threads, but they say users, not bots, and this has not been tried.
  - Do: archive an event's post by hand. Run `/task done`. Archive it again and click a Mark done button in the post. Repeat with `/task edit` with no new person, and with `/task delete`. Then archive it again and run `/task assign` or `/event link` inside the post, because the docs also say application commands can't be used there.
  - Success: each change reaches the overview, and the post is open again afterwards. The code expects the first edit to fail with 50083, then reopens the post and tries once more. Record the real code, whether the button click works, and whether commands work inside an archived post.
  - If it fails: a change that saved with a stale overview should give the reply `The change is saved, but I couldn't update the task list in the event's post`. If it does not, check `editOverview` in `src/events/overview.ts`. If commands can't run inside an archived post, the replies that tell officers to run `/event link` there need a note.

- [ ] **A refused edit of the overview is reported.**
  - Do: add a server AutoMod rule that blocks a test word, and assign a task with that word on an event. Change another task on that event. Repeat with the event's post archived, and again with it locked.
  - Success: if Discord refuses the edit, the reply says the change is saved but the task list in the post is out of date. An archived post reopens and updates instead. Note whether AutoMod applies to a bot's edit at all, and the real code. The code expects 200000. With the blocked task still in place, run `/event close`. If the edit is refused, its reply adds `I couldn't update its overview, so it may still say Active.`
  - If it fails: check `editOverview` in `src/events/overview.ts`, `POST_NOT_UPDATED` in `src/tasks/shared.ts` and `OVERVIEW_NOT_CLOSED` in `src/handlers/event.ts`.

- [ ] **Text typed past autocomplete.**
  - Do: in `/task done`, `/task edit`, `/task delete` and the event option of `/task assign`, type a name without picking a choice and submit. Do it again with a whole short ID the bot showed.
  - Success: if Discord lets free text through, a name gets the reply asking for a choice, and a short ID acts on that row. Note if Discord blocks the submit instead.
  - If it fails: check `chosenTaskId` and `chosenEventId` in `src/tasks/shared.ts`.

- [ ] **A forum that requires tags gives a clear reply.**
  - Do: turn on "Require people to add tags" on a managed forum, and run `/event create`.
  - Success: a reply saying so, with no post made. The bot sets no tags. The code expects Discord's code 40067 before any post exists.
  - If it fails: update `ForumTagRequired`, or tell admins not to require tags on managed forums.

- [ ] **Reading archived threads, as record 6 asks.**
  - Do: leave Read Message History off. Archive a post, cause a retry of its event, and watch what happens.
  - Success: a refusal is treated as no archived posts, as designed. Decide whether the permission is worth adding, and record it.
  - If it fails: a crash or a duplicate post needs a fix before launch.

- [ ] **A post's first message and owner are as expected.**
  - Do: check the bot's post in the API or with Developer Mode. The first message should share the thread's ID, and `owner_id` should equal the application ID.
  - Success: both true.
  - If it fails: adoption after an unclear failure relies on both, so change it in `src/handlers/event.ts`.

- [ ] **Removing a forum stops its posts.**
  - Do: add a task due tomorrow, with the slot open. Remove the forum in `/config`, run the cron by hand and try `/task assign` there. Change a task on one of its events. Then add the forum again.
  - Success: the panel warns with the open-task count, a new `succeeded` row appears, and no posts appear. `/task assign` keeps the task and warns that reminders are off until the forum is added back. `/mytasks` still lists the task. Adding it back says how many event posts were brought up to date, and the changed overview is current. It redraws the 10 most recently changed posts and says so if it could not reach them all. Reminders do not restart in a slot that has already succeeded. They resume with the next slot's run, so check that a day later.
  - If it fails: check `assertManaged` in `src/discord/client.ts`, and `refreshForumPosts` in `src/handlers/config.ts`.

- [ ] **A deleted channel and post are handled.**
  - Do: with both jobs' slots open, delete a post whose event has a reminder due, and a forum with an open task, then run the cron by hand. Use two different forums, and keep the post's forum. If the post's own forum is the one deleted, the run records the forum as gone and gives no `threads_missing`, and the next item needs that forum.
  - Success: new rows for both jobs. `/config` shows the forum as deleted and the rest of the run goes on. The reminders row has `threads_missing` and the event's ID in `missing_event_ids`, and later runs count it in `events_stopped`. Note the codes in Logs. The code expects 10003 for both. `/event status` says the post can no longer be found.
  - If it fails: read `results` in `job_runs` and the health check's logs.

- [ ] **A deleted post gets a replacement.**
  - Do: after the item above, make a post by hand with a different title, and run `/event link` inside it, choosing the event in the event option. Repeat on another event with `/event create` under the same name and date.
  - Success: no second event is made, the old tasks show in the new overview, and reminders for them go out on the next slot's run.
  - If it fails: check `src/handlers/event.ts`. An event left with no post gets no reminders.

- [ ] **Who can delete an event's post.** A post adopted with `/event link` was written by a person, and Discord's rules may let its author delete it. Whether that is so is unverified.
  - Do: as the member, make a forum post. As an officer, run `/event link` inside it. As the member, try to delete the post. Also try to delete a post the bot made.
  - Success: you know who can delete each kind. If the member can, the item above is how an officer recovers. Write this where officers will find it.
  - If it fails: this has no failing result, only a fact to record.

- [ ] **A post that stays locked.** The bot has no Manage Threads, so it cannot undo a moderator's lock.
  - Do: on an event with a task due within 3 days, and another event with a task also due, lock one post. Let three runs go, either the daily crons, or by hand over an hour apart. With the post still locked, read the first health check row written after run three. On the daily crons, that row comes from run three's own invocation. By hand, the health check closed its slot on run one, so runs two and three add no health row. Wait for the next slot, or reopen it as in [Running the cron by hand](#running-the-cron-by-hand), and run the cron once more. Only then unlock the post and let the next slot's run go.
  - Success: runs one and two are `failed` with `reminders_incomplete` and `channels_inaccessible` in `results`, and Logs say `refusal 1 of 3` then `refusal 2 of 3`. Run three is `succeeded`, with `threads_held: 1`, `held_reminders: 1` and the event in `held_event_ids`. The other event's reminder goes out on the first run. That first health check row has `reminders_threads_held: 1`. The health check reads the key from the latest reminders row, so it is gone once the unlocked post's reminders have resumed. `/config` does not list held events, so `job_runs` and Logs are the only places they show. After unlocking, the reminder goes out with its ping, `thread_refusals` on the event goes back to 0, and Logs say `Reminders resumed`. The code expects 160005, so record the real code.
  - If it fails: a job that never reaches `succeeded` means Discord's code is not in `THREAD_REFUSED` in `src/reminders/run.ts`. A reminder sent with no ping means the refusal was not recorded, so check `reminder_log.refused_attempts`.

- [ ] **The bot loses Send Messages across the server.** New posts need Send Messages, which Discord may label Create Posts. Reminders go into existing posts, so they need Send Messages in Threads, which it may label Send Messages in Posts.
  - Do: first, turn off only Send Messages on the bot's role in Server Settings > Roles, and on any forum overwrite that grants it, because an overwrite beats the role. Run `/event create`, and see whether a reminder still reaches an existing post. Then turn off Send Messages in Threads too, and leave View Channel on. With tasks due on two events, let three runs go, as in the item above. Run `/task assign` on one of them. Turn both permissions back on and let the next run go.
  - Success: you can say how this shows up. Stand-in runs gave this, with Discord refusing every send with 50013. Runs one and two are `failed`. From run three on, every run is `succeeded` with both events in `held_event_ids`, and nothing is sent. The forum check passes, because the bot can still read the forum, so each post looks like a single blocked thread. `/event create` says `I'm not allowed to post in that forum.` `/task assign` keeps the task and says the person was not mentioned. Once the permissions are back, the reminders go out with their pings.
  - If it fails: this result is a risk to decide on, not just a fix. After run three the job looks healthy and the freshness alert stays quiet, while no reminder is sent. The signs are `threads_held` in the row, `reminders_threads_held` in the health row, and Logs for an hour. Decide before launch who reads these and how often, and write it down.

- [ ] **The bot is removed from the server.**
  - Do: with tasks due on two events, remove the bot from the test server. Let three runs go, as above, and watch both job rows. Repeat with no task due. Add the bot back as Part 7 of the setup guide does, without changing anything else.
  - Success: the code expects 50001 for every channel. With a task due, every run is `failed` with `channels_inaccessible`, nothing is held, Logs say `Forum refused the bot for event`, and the forum stays active in `managed_channels`. The health check row counts `channels_inaccessible`. With no task due, the reminders job has nothing to send and is `succeeded`, so only the health check row and its log line show the problem. Record whether that is true. After adding the bot back, the waiting reminders go out with their pings. Discord makes a new role for the bot on a re-add, so note whether its forum permissions need setting again, and whether commands work straight away.
  - If it fails: any `succeeded` reminders row with `held_event_ids` here means an outage is being read as blocked threads, so check `#handleThreadRefusal` in `src/reminders/run.ts`.
  - What to do if this happens for real: add the bot back and check its role and forum permissions. If the server should no longer be served, remove its ID from `ALLOWED_GUILD_IDS` and redeploy. Its data is kept.

- [ ] **A server is deleted while it stays on `ALLOWED_GUILD_IDS`.**
  - Do: make a throwaway server. Install the test app and register its commands as Part 7 of the setup guide does, add the server's ID to `ALLOWED_GUILD_IDS` and redeploy, then run `/setup` and `/config`, and make an event and a task due within 3 days. Delete the server, and let a run go with the slots open. Then remove the ID, redeploy and let another run go.
  - Success: you have recorded the code Discord gives. From the code, 10003 for the forum marks it unavailable and counts `channels_gone`, while 10004 or 50001 keeps the job failing every run. Other servers' reminders still go out. After removing the ID, the run stops trying that server, and `results` has `guilds_not_allowed`.
  - If it fails: a job that keeps failing after the ID is gone needs a fix in `src/reminders/run.ts`.

- [ ] **A forum the bot can no longer see.** Whether listing a server's channels includes one the bot can't view is unverified, and the panel relies on that list.
  - Do: deny the bot View Channel on a managed forum and open `/config`. Let the health check run too, with its slot open.
  - Success: note what the panel says. If Discord leaves the forum out of the list, the panel says `deleted from Discord` for a forum that still exists. The health check counts `channels_inaccessible` and does not mark it unavailable. Give the permission back.
  - If it fails: if the panel calls a hidden forum deleted, change the wording in `forumLine` in `src/handlers/config.ts`, because an admin could remove a forum that is only hidden.

- [ ] **A member who left.**
  - Do: assign a task to the member, then have them leave and let a reminder go out.
  - Success: nothing breaks. The bot cannot see that they left, so it keeps mentioning them. An officer should reassign the task.
  - If it fails: a crash here needs a fix. Record 2 accepts the mention.

## Attacks against the live URL

Run these from your own computer.

- [ ] **Bad signature.**

  ```sh
  BAD=$(printf '0%.0s' {1..128})
  curl -i -X POST "$URL/api/interactions" -H "x-signature-ed25519: $BAD" -H "x-signature-timestamp: $(date +%s)" -d '{"type":1}'
  curl -i -X POST "$URL/api/interactions" -d '{"type":1}'
  ```

  - Success: 401 `invalid request signature` both times, or a 403 from the firewall for the second.
  - If it fails: stop. Check `DISCORD_PUBLIC_KEY` and `src/discord/verify.ts`.

- [ ] **Stale timestamp.**

  ```sh
  curl -i -X POST "$URL/api/interactions" -H "x-signature-ed25519: $BAD" -H "x-signature-timestamp: $(( $(date +%s) - 600 ))" -d '{"type":1}'
  ```

  - Success: 401. This alone does not prove freshness is checked, because the signature is also wrong. `src/discord/verify.test.ts` covers that with a good signature. The next item proves it on the live URL.
  - If it fails: stop and check `verifySignedRequest`.

- [ ] **Stale timestamp and allowlist, with a good signature.** Only Discord holds its private key, so this briefly swaps in your own test key. Commands fail until you swap back, and Discord may remove the endpoint URL meanwhile. Use the test project only.

  Make a key, and set the printed value as `DISCORD_PUBLIC_KEY` on the test project. Redeploy.

  ```sh
  node --input-type=module -e '
  import { generateKeyPairSync } from "node:crypto";
  import { writeFileSync } from "node:fs";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync("staging-test-key.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"));
  '
  ```

  Then send signed requests.

  ```sh
  signed_post() {
    local line
    line=$(AGE="$1" BODY="$2" node --input-type=module -e '
    import { createPrivateKey, sign } from "node:crypto";
    import { readFileSync } from "node:fs";
    const key = createPrivateKey(readFileSync("staging-test-key.pem"));
    const timestamp = String(Math.floor(Date.now() / 1000) - Number(process.env.AGE));
    console.log(timestamp, sign(null, Buffer.from(timestamp + process.env.BODY), key).toString("hex"));
    ')
    curl -s -w ' %{http_code}\n' -X POST "$URL/api/interactions" -H "x-signature-ed25519: ${line##* }" -H "x-signature-timestamp: ${line%% *}" -d "$2"
  }
  ping_body() {
    printf '{"type":2,"id":"%s","token":"xxxxxxxxxxxxxxxxxxxx","application_id":"%s","guild_id":"%s","channel":{"id":"%s","type":0},"context":0,"authorizing_integration_owners":{"0":"%s"},"member":{"user":{"id":"%s"},"roles":[],"permissions":"0"},"data":{"type":1,"name":"ping"}}' "$OTHER" "$APP" "$1" "$OTHER" "$1" "$OTHER"
  }
  APP=<test-app-id>
  GUILD=<test-server-id>
  OTHER=$(node -e 'console.log("1".repeat(18))')
  signed_post 0 '{"type":1}'
  signed_post 600 '{"type":1}'
  signed_post 0 "$(ping_body "$GUILD")"
  signed_post 0 "$(ping_body "$OTHER")"
  ```

  - Success, in order: `{"type":1} 200`, then `invalid request signature 401`, then a JSON reply holding `Pong!` with 200, then `forbidden 403`. The third is the control. The endpoint also answers 403 to a body with no `id`, `token` and `channel`, so the fourth means nothing unless the third gave `Pong!` with the same body shape. These gave those results in zsh and bash against a local copy of the endpoint, not against a deployment.
  - Afterwards: set the real `DISCORD_PUBLIC_KEY` back, redeploy, delete `staging-test-key.pem`, and save the Interactions Endpoint URL again if Discord removed it. Confirm `/ping` works.
  - If it fails: a 200 for the stale request, or anything but 403 for the unlisted server, means the check is broken. Do not launch. A 403 on the third means the test proved nothing, so check `APP`, `GUILD` and `ALLOWED_GUILD_IDS`.

- [ ] **Cron without the secret, and with spoofed headers.**

  ```sh
  curl -i "$URL/api/cron/reminders"
  curl -i -H "Authorization: Bearer wrong" "$URL/api/cron/reminders"
  curl -i -A "vercel-cron/1.0" -H "x-vercel-cron-schedule: 0 14 * * *" "$URL/api/cron/reminders"
  curl -i "$URL/api/cron/reminders?secret=$CRON"
  curl -i -X POST "$URL/api/cron/reminders"
  ```

  - Success: 401 `unauthorized` for the first four, and 405 for the last. No new row in `job_runs`, with the slot open when you run this, because a closed slot adds no row either way.
  - If it fails: stop. If a spoofed request runs the job, fix `isCronAuthorized`, and rotate `CRON_SECRET` if it may be known.
  - Afterwards: the fourth request put the test project's secret in a URL. Look for it in Logs while they last. If it shows, rotate `CRON_SECRET` on the test project, and record it in the logs item below.

- [ ] **Source and config files are not served.**

  ```sh
  for target in src src/lib/env.ts package.json vercel.json .env api/interactions.ts api/interactions.js.map api/cron/reminders.js.map supabase/migrations; do
    curl -s -o /dev/null -w "%{http_code} /$target\n" "$URL/$target"
  done
  curl -s -o /dev/null -w "%{http_code} /robots.txt\n" "$URL/robots.txt"
  ```

  - Success: 404 for all but `robots.txt`, which gives 200. The "Only known paths" firewall rule turns those 404s into 403, which is also fine. `/api/interactions.ts` may answer 405 with the rule off, because Vercel routes that path to the function, which refuses a GET. That serves nothing. Note what the two `.js.map` paths give. Nothing has checked them on a real deployment.
  - If it fails: a 200 with file contents means that file is public. Check `outputDirectory` in `vercel.json`. Rotate anything that was served. A `.js.map` that is served exposes the source, and the source is private for now.

- [ ] **A pasted newline in a setting.** Whether Vercel's dashboard keeps a trailing newline is unverified. The code trims every setting, including `CRON_SECRET`.
  - Do: on the test project, copy a new secret with `openssl rand -hex 32 | pbcopy`, as Part 5 of the setup guide does, and paste it as `CRON_SECRET`. Redeploy, and run the cron by hand with that value in `CRON`.
  - Success: a 200. It would be a 401 with nothing in Logs if the secret were compared untrimmed.
  - If it fails: check `isCronAuthorized` in `src/lib/cron-auth.ts`, and fix the copy command in the setup guide.

- [ ] **What Vercel's logs keep.** An interaction token lets its holder reply as the bot, and the bot's requests to Discord carry it in the URL. Whether Vercel records that is unverified.
  - Do: run `/config`, `/mytasks` and a by-hand cron. In Logs, open each entry, including any list of outgoing requests. Search for `webhooks`, `interactions`, `Bearer` and `sb_secret_`. Check whether the full query string of the fourth request in the cron item shows.
  - Success: no token, secret or message text appears. Write down what the logs do keep.
  - If it fails: if a token shows, anyone who can read the logs can reply as the bot for its 15-minute life. Limit who can read them, and add this to `SECURITY.md`. If a secret shows, rotate it.

- [ ] **Old deployment URLs are blocked, and you know what they hold.**
  - Do: copy an older deployment's long URL from Deployments, and `curl -i` it. Then find out whether it keeps old values: rotate `CRON_SECRET` on the test project and redeploy. Briefly set Deployment Protection to none, call the old URL's cron path with the old secret, then set protection back.
  - Success: 401 or a redirect to Vercel's login, and the bot never answers. Record whether the old deployment accepted the old secret. Either way, deleting old deployments after a rotation is the rule in `SECURITY.md`.
  - If it fails: the bot answers on an old URL while protected. Check that the scope is Standard Protection and delete old deployments.

- [ ] **Firewall rules block before the function runs.**
  - Do: repeat the unsigned `curl` a few times, then look at Logs and the Firewall overview.
  - Success: the request shows as denied in the Firewall overview, with no function invocation in Logs. Discord commands still work.
  - If it fails: put the rule back to Log and fix its condition. Check that commands work before making it final.

## Supabase

- [ ] **The publishable key reads nothing.**

  ```sh
  for table in guild_config managed_channels events tasks reminder_log job_runs config_audit interaction_claims task_reassignments; do
    curl -s -w " %{http_code} $table\n" "$SUPABASE/rest/v1/$table?select=*&limit=1" -H "apikey: $PUBLISHABLE"
  done
  curl -s -w " %{http_code} rpc\n" -X POST "$SUPABASE/rest/v1/rpc/claim_interaction" -H "apikey: $PUBLISHABLE" -H "content-type: application/json" -d '{"p_interaction_id":"x"}'
  curl -s -w " %{http_code} root\n" "$SUPABASE/rest/v1/" -H "apikey: $PUBLISHABLE"
  ```

  - Success: every table and `rpc` gets a refusal (401, 403 or 404) with no rows. For `root`, a refusal is fine, and so is a 200 whose document lists no table or function under `paths`. PostgREST on its own answers 200 with an empty OpenAPI document. What Supabase's gateway does at this path is unverified, so write it here.
  - If it fails: rows, or a table name in the `root` document, are a live data leak. Revoke the grant at once, then add it to a migration and find out how it got there.

- [ ] **A hard delete fails at the database.**

  ```sh
  ZERO=00000000-0000-0000-0000-000000000000
  for target in "events?id=eq.$ZERO" "tasks?id=eq.$ZERO" "job_runs?id=eq.$ZERO" "guild_config?guild_id=eq.0"; do
    curl -s -w " %{http_code} $target\n" -X DELETE "$SUPABASE/rest/v1/$target" -H "apikey: $SECRET_KEY"
  done
  ```

  - Success: 403 with code `42501` for all four. An empty 204 means the delete was allowed, even though it matched no row. `guild_config` has no `id` column, so it filters on `guild_id`. A 400 with `42703` means a filter names a missing column, and says nothing about the grant.
  - If it fails: run the grants check below and revoke `DELETE`.

- [ ] **`history` cannot be reached.**

  ```sh
  curl -s -w " %{http_code}\n" "$SUPABASE/rest/v1/row_versions?select=*&limit=1" -H "apikey: $SECRET_KEY" -H "Accept-Profile: history"
  curl -s -w " %{http_code}\n" "$SUPABASE/graphql/v1" -H "apikey: $PUBLISHABLE"
  ```

  - Success: the first is refused, normally 406 with code `PGRST106`. The second is refused, or has no schema to query.
  - If it fails: take `history` out of Exposed schemas, and turn `pg_graphql` off.

- [ ] **What the secret key reaches beyond the tables.** Whether Storage and the Auth admin API answer to an `sb_secret_` key is unverified. A leak of that key would reach whatever they hold.
  - Do: run these on the test project, and repeat the read on production.

    ```sh
    curl -s -w " %{http_code} storage\n" "$SUPABASE/storage/v1/bucket" -H "apikey: $SECRET_KEY"
    curl -s -w " %{http_code} auth\n" "$SUPABASE/auth/v1/admin/users?per_page=1" -H "apikey: $SECRET_KEY"
    ```

  - Success: each is refused, or lists no bucket and no user. Write down which. If they answer, add them to the post-leak checks in `SECURITY.md`.
  - If it fails: a bucket or a user you did not make means someone has been in the project. Rotate the key and read the project's logs.

- [ ] **Legacy keys and sign-ups are off.**
  - Do: try a request with the legacy `anon` key from Settings > API Keys. Then try a sign-up:

    ```sh
    curl -s -w " %{http_code}\n" -X POST "$SUPABASE/auth/v1/signup" -H "apikey: $PUBLISHABLE" -H "content-type: application/json" -d '{"email":"test@example.com","password":"correct-horse-battery"}'
    ```

  - Success: the legacy key gets a 401, and the sign-up is refused. Supabase's docs do not give the exact response for a turned-off key, so check this in the dashboard and note what you see.
  - If it fails: repeat Part 4 of the setup guide. Even a signed-up user should have no access, because of the grants, so also check the publishable key test with that user's token.

- [ ] **Grants are as designed on hosted Supabase.** The test harness runs on PGlite and assumes who granted what. Hosted projects may differ.
  - Do: run these in the SQL Editor.

    ```sql
    SELECT grantee, table_schema, table_name,
      string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
    FROM information_schema.role_table_grants
    WHERE grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
      AND table_schema IN ('public', 'history')
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

    SELECT grantee, table_name, column_name, privilege_type
    FROM information_schema.role_column_grants
    WHERE grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
      AND table_schema IN ('public', 'history')
    ORDER BY 1, 2, 3;

    SELECT grantee, routine_schema, routine_name
    FROM information_schema.role_routine_grants
    WHERE grantee IN ('PUBLIC', 'anon', 'authenticated')
      AND routine_schema IN ('public', 'history');

    SELECT defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl
    FROM pg_default_acl;
    ```

  - Success: `anon`, `authenticated` and `PUBLIC` have no rows in the first three. `service_role` has no `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER`, and nothing in `history`. It has `SELECT` on `guild_config`, `managed_channels`, `reminder_log` and `config_audit`, `SELECT` on `events`, `tasks` and `job_runs`, and no direct write on `job_runs`, which it changes only through `begin_job_run` and `finish_job_run`. Its writes to `events` and `tasks` show only in the column grants: `INSERT` on `events` (`guild_id`, `channel_id`, `name`, `event_date`, `created_by`, `thread_id`, `thread_status`), `INSERT` on `tasks` (`event_id`, `guild_id`, `assignee_id`, `description`, `due_date`, `created_by`), and `UPDATE` only on listed columns. It also has column `INSERT` on `task_reassignments` (`guild_id`, `actor_id`, `task_id`) and no table grant there. `test/db/grants.test.ts` is the reference. Default privileges for `postgres` must not name `anon` or `authenticated` on `public`.
  - If it fails: the migrations ran as a different role, or the platform's defaults differ. Fix the migration and rerun this.

- [ ] **The bot's key and URL work, and connections are as expected.**
  - Do: `/config` loads and saves.
  - Success: the panel works, with no `SUPABASE_` errors in Logs. The key goes in the `apikey` header, because `sb_secret_` keys are not JWTs.
  - If it fails: check the setting names. The code refuses a key without the `sb_secret_` prefix.

- [ ] **Database size and full-disk behaviour.**
  - Do: read the current Free plan database size limit in Supabase's docs and write it here. Note the current size on the project's usage page. Do not fill the database on purpose unless you are ready to recreate the test project.
  - Success: you know the limit, and how much room you have. Row history has no retention, so it grows.
  - If it fails: if size is growing fast, look at `history.row_versions` and `job_runs`.

- [ ] **A database that is full.** Nothing shows whether reminders fail loudly or quietly at the Free plan's limit, or what Supabase does at that point.
  - Do: only on a test project you are ready to recreate, because no role may remove these rows afterwards. With a task due and the slot open, fill it by running this until the usage page shows the limit reached. It adds to `history.row_versions`, so the schema does not change.

    ```sql
    INSERT INTO history.row_versions (source_table, operation, row_id, old_row)
    SELECT 'fill_test', 'UPDATE', g::text,
      jsonb_build_object('pad', (SELECT string_agg(md5(g::text || i::text), '') FROM generate_series(1, 200) AS i))
    FROM generate_series(1, 10000) AS g;
    ```

    Then run the cron by hand and try `/task assign`, `/config` and `/mytasks`.

  - Success: you have recorded what Supabase did. The cron answers 500 `internal error`, or the run is `failed`, and no reminder is marked sent without a message in the post. Commands answer with the fixed `Something went wrong` text, and reads either still work or fail the same way. The freshness alert fires after 30 hours.
  - If it fails: a `succeeded` row with nothing sent, a reminder marked sent that never posted, or a command with no reply needs a fix before launch. Afterwards, delete the project and make a new one.

- [ ] **The project stays awake.**
  - Do: leave the test project with only the daily cron for 8 days. Supabase may pause Free projects after 7 days of low activity. Its docs list API calls as activity, but not direct connections.
  - Success: not paused.
  - If it fails: a paused project fails the bot and the backup job. Find out what counts, and add it.

## Cron and reminders

Read [Running the cron by hand](#running-the-cron-by-hand) first. Each item here that runs the cron needs an open slot and a new row as evidence.

- [ ] **Two crons on one path deploy on Hobby.**
  - Do: open Settings > Cron Jobs. Vercel's docs show this shape, but not on Hobby, where each schedule must run at most once a day.
  - Success: the deployment succeeded and both schedules are listed.
  - If it fails: keep one schedule, and update `begin_job_run` and `SLOT_START_HOUR_UTC`, which both assume the 14:00 slot. The recovery run is then lost.

- [ ] **Each cron really fires, in its hour.**
  - Do: read `job_runs` after 15:00 UTC on seven days, and note each `started_at`. Then check that the 16:00 cron fires too. Open Logs filtered to `/api/cron/reminders` within the hour after it runs, between 16:00 and 17:59 UTC, on at least two days. Hobby keeps logs for one hour, and a cron can fire anywhere in its hour. Note any time between the two crons, and any duplicate delivery you see. These numbers have never been measured. Logs this short can only show a duplicate you happen to catch, so write down how many hours you watched.

    ```sql
    SELECT job_name, status, started_at, error, results
    FROM public.job_runs ORDER BY started_at DESC LIMIT 10;
    ```

  - Success: one `reminders` and one `health_check` row a day with status `succeeded`, started between 14:00 and 14:59 UTC. A second invocation shows in Logs with a 200 and adds no new `succeeded` row in the slot.
  - If it fails: no rows means the cron is not reaching the function. Check that `CRON_SECRET` is set and the deployment is Production. A row with `failed` shows a `category:code` in `error`.

- [ ] **The second cron recovers a failed morning.**
  - Do: with a task due, set a wrong `DISCORD_BOT_TOKEN` on the test project before 14:00 UTC and redeploy. Put the right one back after the morning run, before 16:00 UTC, and redeploy.
  - Success: a `failed` row in the 14:00 hour, a `succeeded` row in the 16:00 hour, and the reminder sent with its ping. The `started_at` of that row is also a measured time for the second cron.
  - If it fails: if the failed run sent reminders, or the recovery run does not start, see the lock in `20261104000008_job_run_lock.sql`.

- [ ] **Running cron twice sends nothing twice.**
  - Do: check that the slot is open, then run the cron by hand twice, with a task due and reminders on.
  - Success: `ok` both times, one reminder in the post, and one new `succeeded` row for each job. A closed slot would also give `ok` and one reminder at most, so this counts only with the new rows.
  - If it fails: duplicates need a fix in the claim functions. One duplicate after a crash is accepted, but not in a clean run.

- [ ] **Two runs at the same moment on the real stack.** Most test runs used a stand-in that handles one request at a time.
  - Do: with the slot open and a task due, send two at once. Then double-click a Mark done button, and have two people save the `/config` panel at the same time.

    ```sh
    curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $CRON" "$URL/api/cron/reminders" &
    curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $CRON" "$URL/api/cron/reminders" &
    wait
    ```

  - Success: both answer 200, there is one new `succeeded` row for each job, and one reminder in the post. One Mark done takes effect, and the other click says it is already done. One panel saves, and the other is told someone else saved first.
  - If it fails: check `begin_job_run` and the claim functions, and treat any duplicate as a bug.

- [ ] **Mark done works on reminders.**
  - Do: make six tasks due in the same event, one with the hostile text above, and let a reminder run go out. As the assignee, click one task's button. As the member, click another person's. Then click a done task's button again.
  - Success: each task has its own button on the message where its text ends, labelled `✅ Done - ` and the start of the task, or `✅ Mark done` if nothing usable remains. A message holds at most five. The label shows as plain text. The assignee gets a private confirmation and the public message stays as it was. The member gets the fixed refusal. The repeat click says it is already done.
  - If it fails: a failed send here affects the whole reminder, so check `src/reminders/render.ts` and `src/tasks/done.ts` before launch.

- [ ] **The overview stays current.**
  - Do: assign, edit, complete and delete a task, and close an event, watching the post's overview.
  - Success: the overview shows each change, pings nobody, and shows the event as closed.
  - If it fails: check `refreshOverview` in `src/events/overview.ts`. A failed refresh must not undo the change, so confirm the task itself saved.

- [ ] **Reminder timing around a real due date.**
  - Do: make tasks due in 3 days, 1 day and today, and let the morning run go. `/task assign` refuses a past date, so the overdue case is the task due today, a day later. To see it sooner, move a task's date on the test project only, then let the next slot's run go:

    ```sql
    UPDATE public.tasks SET due_date = due_date - 1 WHERE id = '<task-id>';
    ```

  - Success: each person gets the most urgent reminder that applies, in the event's post, and the time falls in the expected window. The cron is in UTC, so in Eastern time it moves one hour with daylight saving.
  - If it fails: check the guild's `timezone`, which defaults to `America/New_York`, and `src/reminders/plan.ts`.

- [ ] **Two weeks on the real stack.** Long periods have only been simulated, in one time zone. A clock change has not been seen live.
  - Do: leave about 10 tasks on the test project, with due dates spread over two weeks. Each day, read `job_runs` and this. If a clock change falls before launch, keep it running across that too.

    ```sql
    SELECT task_id, kind, due_date, state, attempts, refused_attempts, sent_at
    FROM public.reminder_log ORDER BY due_date, task_id, claimed_at;
    ```

  - Success: each task gets its reminders at 3 days, 1 day, on the day and after it, as far as `src/reminders/plan.ts` says, with none twice.
  - If it fails: copy the rows and the post's messages into an issue, with made-up data only.

- [ ] **The kill switch works.** A run with reminders off still succeeds and closes the slot, and turning them back on does not reopen it. Reminders resume with the next day's run. A reminder whose day passed while they were off is not sent late.
  - Do: make a task due today. With the slot open, turn reminders off in `/config`, and run the cron by hand. Read the panel. Turn reminders on, and run the cron by hand again. Then let the next day's run go.
  - Success:
    - The off run adds a new `succeeded` row with nothing sent. This row is the evidence. Without it, nothing tested the switch.
    - The panel says that turning them on after the day's run does not reopen it.
    - Turning on replies `Reminders are on. If the day's run (around 14:00 UTC) has already happened, they resume with the next day's run.`
    - The second by-hand run answers `ok`, adds no row and sends nothing. That is the design, not a failure.
    - The next day's run adds a new `succeeded` row and sends the overdue reminder. In `reminder_log`, the task has `due_day` as `skipped` and `overdue` as `sent`.
  - If it fails: do not launch if anything sends while off. This is your emergency stop.

## Backups

These come from [BACKUPS.md](BACKUPS.md), which holds the steps.

- [ ] **Whether Supabase allows `BYPASSRLS` for `backup_ro`.**
  - Do: look at the migration's outcome, and run `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'backup_ro';`.
  - Success: `t`, or `f` with one `backup_ro_read` policy on each table.
  - If it fails: an error code other than `42501` stops the migration, which must then be adjusted.

- [ ] **The real backup job through Supabase.**
  - Do: run the workflow by hand from the backups repo. This workflow has never committed to a real private repo, because that repo does not exist yet, so read the first commit closely.
  - Success: a new `.data.age` file and manifest committed, and row counts passed.
  - If it fails: use the table in "When a run fails".

- [ ] **The pooler username form, and connections.**
  - Do: use `backup_ro.<project-ref>` with the session pooler host, and look for connection errors. The role's limit is 3.
  - Success: the job connects and leaves no connections held open.
  - If it fails: update `BACKUP_PGUSER` and the docs.

- [ ] **A leaked backup password cannot stall reminders for long.** Any role that can log in can take the job's lock. `begin_job_run` waits 3 seconds for it. How long the pooler lets an idle session hold it is unverified.
  - Do: on the test project, log in as `backup_ro` through the session pooler, and hold the lock in an idle session. With the slot open, run the cron by hand. Leave the session open, note when it ends by itself, if it does, and then close it.

    ```sql
    SELECT pg_advisory_lock(hashtextextended('job_runs:reminders', 0));
    ```

  - Success: the by-hand run answers 500 `internal error` after a few seconds and sends nothing. Once the session closes, a run works. Record how long the session lasted, and add it to the "Database password exposed" part of `docs/BACKUPS.md`.
  - If it fails: a run that hangs to the function's limit means the lock wait is not working behind the real pooler. Check `begin_job_run` in `20261104000014_database_grants_and_lock_order.sql`.

- [ ] **`sslmode=verify-full` with the dashboard's CA file.**
  - Do: part of the job above.
  - Success: no certificate errors.
  - If it fails: check `backup/supabase-ca.pem`. Do not lower the mode.

- [ ] **A secret canary stays out of Actions logs.**
  - Do: run a dry run with a made-up value in a secret and search the logs for it, including any transformed form.
  - Success: nothing found.
  - If it fails: remove what printed it, then rotate.

- [ ] **A real restore by each key holder.**
  - Do: each holder follows "Restore drill" with their own key, on their own machine, using the newest real backup. Run `pg_restore --version` first and record it. `brew install libpq` may bring a client newer than 17, and a newer client against a Postgres 17 archive is untested.
  - Success: the script prints `OK`, and everything on that section's checklist is ticked. Each holder took the identity from where they said they keep it, and has the offline copy too.
  - If it fails: backups you cannot restore are not backups. Do not launch.

- [ ] **The recovery steps on a staging project.**
  - Do: follow "Real recovery" into a new project, including `supabase migration repair` and repointing the bot. Its `DEFAULT ACL` step was only tried on a stand-in, so note what the hosted project does there.
  - Success: the bot works on the recovered project, the grants item above passes on it, and a new backup passes.
  - If it fails: correct `docs/BACKUPS.md`. These steps are marked untested there.

- [ ] **The freshness alert fires.**
  - Do: delete the `REMINDER_CHECK` variable in the backups repo. Then use Settings > Cron Jobs > Disable Cron Jobs on the test project for over 30 hours, and run the backup. Turn crons back on.
  - Success: the backup commits, then the check fails with `reminders last succeeded N hours ago`, and GitHub emails whoever last changed the `cron` line. After a restart it passes again. Health check rows also show `reminders_stale`.
  - If it fails: check the workflow's condition on `vars.REMINDER_CHECK`, and who receives failure emails.

- [ ] **A stopped backup schedule gets noticed.**
  - Do: if you use `BACKUP_HEARTBEAT_URL`, pause the job and confirm the service alerts you. Otherwise, put the monthly check in a calendar.
  - Success: you hear about it.
  - If it fails: do the monthly check by hand.

## Build and runtime

- [ ] **Install scripts stay off in the real build.**
  - Do: read the deployment's build log.
  - Success: the install respects `.npmrc`, and no package install script runs.
  - If it fails: stop deploying, and check the root `.npmrc` for `ignore-scripts=true`.

- [ ] **The runtime Node version is current.**
  - Do: temporarily log `process.version` on `staging`, or read it from the deployment details. Compare it with Node's latest 24.x security release.
  - Success: on a patched 24.x.
  - If it fails: redeploy to pick up the current one, and check `engines`.

- [ ] **Cold starts fit in 3 seconds.**
  - Do: run `/config` after an hour idle, several times over a day. Do the same with `/event status`, `/event close`, `/event delete` and its Confirm button, which used to make two database reads before answering, and with an autocomplete field in `/task done`, which still can.
  - Success: no "did not respond". The router allows 1.5 seconds for its database read, and the event routes now load their row after answering.
  - If it fails: move Supabase or Vercel to closer regions. After a "did not respond" on `/event close` or Confirm, check whether the close or delete still happened, because the work can go on after a late answer.

- [ ] **A late answer and a slow finish.** Whether `waitUntil` keeps work alive after a late answer, what Discord shows then, and what happens when a function is stopped at 60 seconds are all unverified.
  - Do: on `staging` only, in `handle` in `api/interactions.ts`, add `await new Promise((resolve) => setTimeout(resolve, 3500));` just before `return respond(reply);`, and deploy. Run `/task done`. Then remove that line, change `waitUntil(after());` to `waitUntil(new Promise((resolve) => setTimeout(resolve, 70_000)).then(after));`, deploy and run `/mytasks`. Put the code back and deploy.
  - Success: you have recorded what Discord showed each time, whether the task was marked done, and what Logs show when the function is stopped.
  - If it fails: if a person is told a command failed while the change saved, or a reply stays on "thinking" with nothing in Logs, write down what officers should do when they see it, and decide whether the code needs a shorter budget.

- [ ] **Rollback.**
  - Do: use Instant Rollback on the test project, and check what the bot does. Vercel restores the old deployment's cron definitions too.
  - Success: the bot works, and you know which fixes the rollback undid. Roll forward afterwards.
  - If it fails: redeploy the current commit. Never roll back past a security fix.

- [ ] **Code and schema released in the wrong order.** Current code is known to break on an older schema after a restore. A normal release has not been tried, and neither has a rollback onto a newer schema.
  - Do: take a change with a migration, on the test project. First deploy the code without pushing the migration, and run `/config`, `/mytasks`, `/task assign` and the cron by hand. Then push the migration to the test project. The CLI may still be linked to production from the last release, so link it first and read the target before the real push:

    ```sh
    supabase link --project-ref <test-project-ref>
    supabase db push --remote --dry-run
    ```

    The first line of the output should start with `Target:` and name the test project. Stop if it names production or says `local stack`. The exact wording for a linked project has not been seen, so correct this line when you see it. If the CLI rejects `--remote`, it is older than 3.0.0, so run `brew upgrade supabase`. If the target is right, push:

    ```sh
    supabase db push --remote
    ```

    Run `/config`, `/mytasks`, `/task assign` and the cron by hand again. Then use Instant Rollback to the deployment from before the change, and run them a third time. Roll forward.

  - Success: you have recorded which commands fail in each state, and what the person sees. Reminders are not marked sent without a message. Then write the release order into the handoff guide: which goes first, migration or merge, and how long the gap may be.
  - If it fails: a state that loses data or sends duplicates means that kind of migration must be made in two steps. Do not release it as one.

- [ ] **Normal use and a flood, measured.** Nothing has measured Vercel usage, Discord's global rate limit or Supabase connections.
  - Do: note the numbers on Vercel's and Supabase's usage pages. Give the test event 40 more tasks, due tomorrow, on the test project only:

    ```sql
    INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
    SELECT event.id, event.guild_id, '<member-id>', 'Load test ' || g, current_date + 1, '<member-id>'
    FROM public.events AS event, generate_series(1, 40) AS g
    WHERE event.id = '<event-id>';
    ```

    A trigger allows one `created_by` 50 new tasks in 24 hours, so a second run of this within 24 hours fails with `officer task limit reached`. Use the insert once, or put a different ID in `created_by`.

    With the slot open, run the cron by hand, and during the run read `SELECT count(*) FROM pg_stat_activity;`. Afterwards, send a small flood of unsigned requests from one computer, run `/ping` during it, and note the usage pages again an hour later.

    ```sh
    for i in {1..300}; do curl -s -o /dev/null "$URL/api/interactions" -X POST -d '{}'; done
    ```

  - Success: you have recorded how long the run took against its 40-second budget, any `deferred_cap` or rate limit counts in `results`, the connection count, and what the flood cost. `/ping` still answered. Compare each with the plan's limits, and work out how many such floods a month the limits allow.
  - If it fails: a run that hits its budget at a size the club could reach needs a lower `maxMessages` in `src/reminders/run.ts`, because what does not fit waits a day. If the flood stopped `/ping`, tighten the firewall rule.

## Settings to confirm

Look at each one on the dashboard. Repeat on production.

- [ ] **All four accounts** use a passkey or hardware key, or for Supabase two authenticator factors. Recovery codes are saved, and the recovery email is long-lived.
- [ ] **Vercel secrets** have type Secret, and their values cannot be read after saving. Rotate any that were stored otherwise.
- [ ] **Vercel settings** exist only in the Production environment. Production values exist only in the production project.
- [ ] **No database password or connection string** is in Vercel or in this repo's Actions secrets.
- [ ] **Branches.** Pushing a branch other than `main` or `staging` creates no deployment in either project. The production project may build `staging` as a preview.
- [ ] **Deployment Protection** is Standard Protection, and Discord points at the production domain.
- [ ] **No bypass.** No Protection Bypass for Automation secret exists, and `VERCEL_AUTOMATION_BYPASS_SECRET` is absent.
- [ ] **Firewall rules** are active, and usage notifications are on.
- [ ] **Vercel integrations and Supabase organisation members** are only those you expect.
- [ ] **Supabase** has legacy keys off, GraphQL off, sign-ups off and Exposed schemas set to `public` only.
- [ ] **Discord app** has Public Bot off, User Install off and Install Link set to None, and its endpoint URL is yours. Anyone who can change that URL can receive every interaction token.
- [ ] **Discord roles.** The groups holding Administrator, Manage Roles, and the two bound roles are small. Review them each term, because the bot is not told about grants.
- [ ] **A stolen officer account.** Talk through it once: use `/config` to turn reminders off, find the task through `/event status`, remove it, then tell members.
- [ ] **Handoff.** A second key holder exists, and the next maintainer knows where to find the handoff guide.
- [ ] **The owner is away.** Ask the second key holder to answer these from the guides alone, without your help: where are the accounts, how do I turn reminders off, and how do I restore. Fix what they could not find. Nobody has tried this.
- [ ] **What a leaked bot token can change.** On the test app only, read the bot's token with `read -rs BOT`, then send a `PATCH` to `/api/v10/applications/@me` on Discord's API host, with the header `Authorization: Bot $BOT` and the JSON body `{"description":"staging check"}`. Reset the token in the portal and check whether the description survives. Then put the new token in `DISCORD_BOT_TOKEN` on the test project and in `.env`, redeploy, and read it into `BOT` again, or the test bot's calls to Discord fail and so does the restore below. If the call works, a leaked token can probably change the endpoint URL too, and a reset does not undo it. So add a check of the endpoint URL and intents to the rotation steps in `SECURITY.md`. Restore the description.
- [ ] **Vendor changes.** Write down the versions in use today: the Supabase CLI, the PostgREST version, if the dashboard shows it, the Discord API version in `src/discord/client.ts`, Vercel's Node version and the Hobby and Free plan limits you read. Dependabot does not watch these. Put a check in the calendar each term, with the date these were last read, and repeat a sample of this list after any change.
- [ ] **Member data.** The docs set no retention period, and no process for a deletion request or a member who has left. Row history and backups keep old values. Find out what is really kept: make a task with a made-up marker word, edit it and delete it with `/task delete`, then run the query below. Then look for the word in a backup restored by the drill. Ask the club and the university whether they have rules for this, and write down a retention period and who answers a request. This is unsettled until someone decides it.

  ```sql
  SELECT source_table, operation, row_id, changed_at
  FROM history.row_versions
  WHERE old_row::text LIKE '%<marker-word>%'
  ORDER BY changed_at DESC;
  ```

## Not covered by a live test

These stay open after this list is finished, because no staging run can answer them.

- **Mutation testing** stopped early, with many mutants not run, and it did not touch workflow files, gitleaks configs or hook scripts.
- **Actions logs and pull request edit histories** were not all read for leaks, and commit messages were only scanned by pattern, so an unusual real name could be missed. [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) requires a person to read these before going public.
