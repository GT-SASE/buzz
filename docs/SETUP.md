# Setup

This guide takes you from nothing to the bot working on a private test server, then to production. It assumes you have not used Discord's developer tools, Vercel or Neon before.

Do the steps in order. Each one says what to expect and what a failure looks like.

The docs for these services were last checked on 2026-11-04, and dashboards move. The Neon steps were written on 2026-11-11 and have not yet been tried live. Where a step says **check this in the dashboard**, the official docs did not confirm the exact label or location, so look for it and note any difference here.

## What you will end up with

|                   | Test                | Production         |
| ----------------- | ------------------- | ------------------ |
| Discord app       | Test app            | Real app           |
| Discord server    | Private test server | The club's server  |
| Neon project      | Test project        | Production project |
| Vercel project    | Test project        | Production project |
| Production branch | `staging`           | `main`             |
| Secrets           | Used only here      | Used only here     |

Never reuse a key, token or password between the two columns.

## Before you start

You need:

- A Mac or Linux computer with Node.js 24, Git, Bash, curl 7.71 or later, OpenSSL and `psql`.
- A password manager.
- A passkey or hardware security key, plus a second one as a backup if you can.
- A second Discord account, to act as an ordinary member. A friend's account is fine.
- Administrator on the club's server for the production part, or someone who has it and can help.

The bot is deployed from `main` and `staging`. Everything you want to run must be merged first. Then get the code and check it:

The package manager is pnpm, pinned in `package.json`. If `pnpm --version` fails, run `corepack enable`, which ships with Node 24 and then runs exactly the pinned version.

```sh
git clone <repository-url>
cd <repository-folder>
pnpm install --frozen-lockfile
pnpm gitleaks:install
pnpm hooks:install
pnpm typecheck && pnpm lint && pnpm test
```

**Expect:** the checks pass.

Then keep local-only files out of Git. `.gitignore` covers secrets and data, but not your own tools' configuration files, and `git add -A` would stage those. Tracked files here do not name such tools, so keep your own list somewhere private. For each file or folder of that kind you keep in the clone, run:

```sh
printf '%s\n' '<file-or-folder>' >>"$(git rev-parse --git-path info/exclude)"
git check-ignore -v '<file-or-folder>'
```

**Expect:** the second command prints a line naming `info/exclude`. This belongs to one clone and is not pushed, so repeat it in every new clone.

## Part 1: Secure all four accounts

Do this first. Whoever takes over one of these accounts can defeat every control in the code.

Use a long-lived personal email as the recovery address, not a university address that may end when you graduate. Save every recovery code in the password manager.

### GitHub

1. Go to Settings > Password and authentication. Turn on two-factor authentication and add a passkey or security key. Check this in the dashboard.
2. Go to Settings > Emails. Turn on "Keep my email addresses private" and "Block command line pushes that expose my email". Check this in the dashboard.
3. In your clone, run `git config user.email` and confirm it shows your GitHub noreply address.

**Failure looks like:** a push refused because it would expose your email. Set the noreply address with `git config user.email` and amend the commit.

### Discord

1. Open User Settings > My Account. Under Password and Authentication, choose Register a Security Key and follow the prompts. Discord treats a passkey as a security key.
2. Register a second key if you have one, and save the backup codes.

**Failure looks like:** the Developer Portal refusing to let you create a team, which needs two-factor authentication.

### Vercel

Sign up with your GitHub account, because Vercel Hobby checks that the commit author is the account owner.

1. Open Account Settings > Authentication. Add a passkey with **Add New** > **Passkey**.
2. Turn on two-factor authentication and save the recovery codes.

Vercel's forum has reports of people locked out after losing their only passkey, so keep the recovery codes safe and add a second method.

### Neon

1. Sign up with your GitHub account, so the login is protected by GitHub's two-factor authentication.
2. Look in your account settings for a two-factor or passkey option of Neon's own, and turn it on if there is one. Check this in the dashboard.

## Part 2: Create the test server

1. In Discord, turn on User Settings > Advanced > Developer Mode, so you can copy IDs.
2. Click **+** in the server list and create your own server. Do not invite anyone yet.
3. Create five roles: `Test E-board`, `Test Events Directors`, `Test Events Committee`, `Test Treasury` and `Test Marketing`. Give them no extra permissions.
4. Create a forum channel called `test-events`. If the forum option is missing, turn on Community in Server Settings. Check this in the dashboard.
5. Invite your second account. Do not give it either role yet.
6. Right-click the server icon and choose Copy Server ID. Keep it for later as your test server ID.

Use only made-up names and data on this server.

## Part 3: Create the test Discord app

Open the Discord Developer Portal and choose **New Application**. Name it so it is clearly the test one, and avoid the club's name.

### Copy the IDs

On General Information, copy the Application ID and the Public Key. Neither is secret.

### Create the token

On the Bot page, choose Reset Token and copy the token into the password manager. Discord shows it once. Anyone holding it can act as the bot.

### Turn off public installs

The order matters. Discord refuses to make an app private while it still has an install link.

1. On the Installation page, set Install Link to **None**.
2. Under Installation Contexts, turn **User Install** off and leave Guild Install on.
3. On the Bot page, turn **Public Bot** off.
4. On the same page, leave **Requires OAuth2 Code Grant** off, and leave all three privileged gateway intents off. The bot opens no gateway connection, so it needs none.
5. Save.

Check these labels in the dashboard.

**Failure looks like:** "Private application cannot have a default authorization link". The Install Link is still set, so go back to step 1.

Do not set the Interactions Endpoint URL yet. Discord tests it when you save, and nothing is running yet.

## Part 4: Create the test Neon project

In the Neon console, create a project on the Free plan, with Postgres version 17. Choose a region close to Vercel's function region. Vercel's default is Washington, D.C. (`iad1`), which suits an AWS US East region. Check both in the dashboards. Slow database reads can exceed the 2.2 seconds the bot allows before replying.

Neon makes a database, `neondb` by default, and an owner role, `neondb_owner` by default. The owner owns everything the migrations make, and can create roles, which the migrations need. Save its password in the password manager.

On the Free plan, the compute stops after a few minutes with no queries, and the first query after that waits for it to start. `scripts/neon-cold-start.ts` times that first query; the staging checklist has an item for it.

### Run the migrations

Open the project's **Connect** dialog. Choose the `neondb_owner` role and the database, and turn connection pooling off, so the host has no `-pooler` in it. Change `sslmode=require` at the end to `sslmode=verify-full`, which also checks the server's certificate and name. Save the string in the password manager.

Then apply the migrations with [dbmate](https://github.com/amacneil/dbmate), which `pnpm install` brings. `read -rs` waits for you to paste the string, and keeps it out of your shell history and off the screen.

```sh
read -rs OWNER_URL
DATABASE_URL="$OWNER_URL" pnpm db:migrate
```

**Expect:** `Applying:` and `Applied:` for each file in `db/migrations`, in order. Run it again and it prints nothing. The Tables page shows `guild_config`, `events`, `tasks` and others, all empty.

dbmate applies each new file in its own transaction and records it in `public.schema_migrations`. An applied file never changes: make later changes as new files with `pnpm exec dbmate --migrations-dir db/migrations new <name>`.

**If it fails:**

- `permission denied`: the role is not the owner or cannot create roles. Use the project's owner role, never `bot_app`.

### Set the bot's password

The baseline creates `bot_app`, the only role the bot logs in as, with no password, so nobody can log in as it yet. Generate one:

```sh
openssl rand -hex 32
```

Hex needs no encoding in a URL. A password from `openssl rand -base64 32` works too, but any `+`, `/` or `=` in it must then be percent-encoded in the connection string. Save it in the password manager. Then, as the owner, run this once, in Neon's SQL editor or in `psql "$OWNER_URL"`:

```sql
ALTER ROLE bot_app PASSWORD '<password>';
```

In `psql`, `\password bot_app` does the same and asks for the password instead, so it stays out of the command and out of any query history.

### Build the bot's connection string

Open **Connect** again. Choose the `bot_app` role and the same database. Neon does not know a password set with SQL, so put yours in yourself. The string has this shape:

```text
postgresql://bot_app:<password>@<host>/<database>?sslmode=verify-full
```

`<password>` is the one you set with `ALTER ROLE` above. It must be percent-encoded: hex needs no change, but `+`, `/`, `=`, `@`, `:` and `%` each do.

The bot sends each query to Neon over HTTPS, which always checks the certificate, so `sslmode` does not change what the bot does. Keep `sslmode=verify-full` anyway, for when you use the string with `psql` or dbmate. Keep it in the password manager. It goes into Vercel in the next part.

Check that it logs in, after pasting it at the prompt:

```sh
read -rs BOT_URL
psql "$BOT_URL&sslrootcert=system" -c 'SELECT current_user;'
```

**Expect:** `bot_app`. `sslrootcert=system` needs `psql` 16 or later, and lets it check Neon's certificate against the system's roots. Leave it out of `DATABASE_URL`.

**Failure looks like:** `password authentication failed`. Check the password and any percent-encoding. Then clear both with `unset OWNER_URL BOT_URL`.

## Part 5: Deploy the test project on Vercel

### Create the project

1. Choose **Add New** > **Project** and import the GitHub repository. Give Vercel access to this repository only.
2. Name the project without the club's name, because the name becomes a public URL: `<name>.vercel.app`.
3. Leave the framework as Other and the root directory as it is. `vercel.json` sets the rest.
4. Deploy. The first deployment builds `main` and has no settings, so every request to it fails. That is fine.

**Failure looks like:**

- "Hobby accounts are limited to daily cron jobs": a schedule in `vercel.json` runs more than once a day.
- A blocked deployment naming the commit author: the commit's author must be the Vercel account's owner. Check your Login Connections and `git config user.email`.

### Set the production branch

Go to Settings > Environments > Production > Branch Tracking, enter `staging` and save. Older screens have this under Settings > Git.

### Generate the cron secret

```sh
openssl rand -hex 32 | tr -d '\n' | pbcopy
```

This copies exactly 64 characters to the clipboard on a Mac, with no newline at the end. A newline saved in the setting could make every cron request fail with a 401. On Linux, leave off `| pbcopy`, copy only the 64 characters, which your prompt then follows on the same line, and clear your terminal afterwards. The endpoint refuses every request if `CRON_SECRET` is unset or under 32 characters.

### Add the settings

Go to Settings > Environment Variables. Add each one below with **Production** as the only environment. Vercel now calls its write-only type **Secret**, and older docs call it Sensitive.

| Name                           | Type   | Value                                      |
| ------------------------------ | ------ | ------------------------------------------ |
| `DISCORD_APP_ID`               | Config | Test app's Application ID                  |
| `DISCORD_PUBLIC_KEY`           | Config | Test app's Public Key                      |
| `DISCORD_BOT_TOKEN`            | Secret | Test app's bot token                       |
| `ALLOWED_GUILD_IDS`            | Config | Test server ID                             |
| `DATABASE_URL`                 | Secret | `bot_app`'s connection string, from Part 4 |
| `CRON_SECRET`                  | Secret | The value you just generated               |
| `ENABLE_EXPERIMENTAL_COREPACK` | Config | `1`                                        |

**Expect:** after saving, a Secret's value can no longer be read in the dashboard.

`ENABLE_EXPERIMENTAL_COREPACK=1` makes Vercel install with exactly the pnpm that `packageManager` in `package.json` pins, from `pnpm-lock.yaml`. Install scripts stay off, because `.npmrc` sets `ignore-scripts=true`, which pnpm reads. It also sets `node-linker=hoisted`, since the functions' file tracing misses packages in pnpm's default symlinked layout.

Never put the owner's connection string here. The bot does not check which role the string names, and the owner's would bypass every grant.

The bot reaches Neon with its HTTP driver, `@neondatabase/serverless`: one HTTPS request per query, with no connection to open or keep. A request Discord is waiting on gives up after 2.2 seconds, and others after 8. No query is ever sent twice. The role's `statement_timeout` of 10 seconds bounds the work on the server. It is only a default: anyone logged in as `bot_app` can lift it with `SET`, so it does not contain a leaked password.

### Lock down old deployments

Go to Settings > Deployment Protection.

1. Turn on Vercel Authentication with the **Standard Protection** scope. This protects every URL except the production domain.
2. Do not choose **All Deployments**, because that blocks Discord too.
3. Do not create a Protection Bypass for Automation secret, and do not create shareable links.

### Create the branch and deploy

`vercel.json` deploys only `main` and `staging`.

```sh
git switch main
git pull
git switch -c staging
git push -u origin staging
```

**Expect:** a Production deployment of `staging` that reaches Ready. Settings > Cron Jobs lists `/api/cron/reminders` twice, at `0 15 * * *` and `0 17 * * *`.

If you change a setting later, redeploy from the Deployments page, because a deployment does not pick up new values.

### Test it

Use the production domain, not the long deployment URL.

```sh
curl -i https://<name>.vercel.app/robots.txt
curl -i -X POST https://<name>.vercel.app/api/interactions
curl -i https://<name>.vercel.app/api/cron/reminders
```

**Expect:** 200, then 401 `invalid request signature`, then 401 `unauthorized`.

These prove routing only. The function gives the same answers with every setting missing, because it refuses both requests before it reads the settings they would need. Part 6's save is the first real test of `DISCORD_PUBLIC_KEY`.

Now open Logs, within the hour, because logs last one hour on Hobby. **Expect:** no line saying `Cron secret is unset or too short`. If there is one, `CRON_SECRET` is missing or short, so set it and redeploy. This line is the only sign of that here, and without the setting the daily job never runs.

**Failure looks like:** a Vercel login page. You used a protected deployment URL, or chose All Deployments.

## Part 6: Connect Discord to the bot

On the app's General Information page, set Interactions Endpoint URL to the following and save:

```text
https://<name>.vercel.app/api/interactions
```

**Expect:** the page saves. Discord sends a signed PING and also tries a bad signature. It needs a PONG for the first and a 401 for the second.

**Failure looks like:** "could not be verified". Check that:

- `DISCORD_PUBLIC_KEY` belongs to this app, and the deployment came after you set it. If the key is missing or malformed, Logs show a line such as `Invalid configuration for DISCORD_PUBLIC_KEY: must be set`.
- The URL uses the production domain and ends in `/api/interactions`.
- The curl tests above still answer as they did. That shows only that the URL reaches the function.

Discord may also remove a working URL later if it fails these checks, and it will email you if so.

## Part 7: Invite the bot and register commands

Invite first. Discord refuses to register commands for a server the app has not joined.

### Invite with no permissions

1. On the app's OAuth2 page, open the URL Generator. Check this in the dashboard.
2. Choose the scopes `bot` and `applications.commands`.
3. Tick no permissions.
4. Confirm the generated URL contains `permissions=0`. If it has no `permissions` part, add `&permissions=0`.
5. Open the URL and choose the test server.

**Expect:** the bot joins with no permissions of its own, and shows as offline. It never comes online, because it uses no gateway connection. It still gets whatever the server gives `@everyone`.

Only the app's owner can add a private app. Check this on the test server.

### Give it access to one forum

Open `test-events` > Edit Channel > Permissions, add the bot as a member and allow exactly these:

- View Channel
- Send Messages, which Discord may label **Create Posts** on a forum. Check this in the dashboard.
- Send Messages in Threads, which it may label **Send Messages in Posts**.

Leave Manage Threads off.

### Register the commands

```sh
cp .env.example .env
chmod 600 .env
```

Fill in `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN` and `ALLOWED_GUILD_IDS` with the test values. `.env` is ignored by Git. Then run:

```sh
pnpm commands:register <test-server-id>
```

**Expect:** `Registered N command(s) in server <id>`. N is one for each top-level command in `src/handlers/modules.ts`.

| Failure                                                 | Meaning                                     |
| ------------------------------------------------------- | ------------------------------------------- |
| `Server ID 1 on the command line is not in ALLOWED_...` | The ID differs from `ALLOWED_GUILD_IDS`     |
| `Discord answered 401 for server ...`                   | The token is wrong or was reset             |
| `Discord answered 403 for server ...`                   | The bot has not been invited to that server |
| `Invalid configuration for ...`                         | That setting is missing or malformed        |

Run this again whenever the commands change. It replaces the server's whole command list.

### Try it

Type `/ping` in the test server.

**Expect:** a reply only you can see: `Pong!`.

**Failure looks like:**

- "The application did not respond": open Vercel's Logs. Try again once, because a first request after idle can be slow.
- "Interaction failed" with a 403 in the logs: the server ID does not match `ALLOWED_GUILD_IDS`, or the real payload differs from what the code expects. See [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md).

## Part 8: Set up the bot in Discord

### `/setup`

As a server Administrator, run `/setup` and choose a role for each option:

| Option                  | Role                    | What it does                                                                                                          |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `eboard_role`           | `Test E-board`          | Admin and officer rights: changes the bot's settings with `/config`, creates events, assigns steps, approves budgets. |
| `events_directors_role` | `Test Events Directors` | Officer rights: creates events, assigns steps, approves budgets. Not admin, so no `/config`.                          |
| `events_committee_role` | `Test Events Committee` | Shown in `/config`. Decides nothing yet.                                                                              |
| `treasury_role`         | `Test Treasury`         | Pinged when a Budget Sheet is done. Can approve budgets.                                                              |
| `marketing_role`        | `Test Marketing`        | Pinged when an Engage post is up.                                                                                     |

All five are required. E-board is also saved as the admin role, since the club has no separate one. None can be `@everyone` or a role an integration manages.

**Expect:** a private message listing the five roles by the club's names, with E-board shown as `E-board (also admin)`, and which roles may be able to grant them, with a Confirm button. Click it within an hour. You should see `Saved.` and the five roles again.

**Failure looks like:**

- `You can't do that, or it doesn't exist.`: you do not hold the Administrator permission.
- `The ... role can't be @everyone` or `... because an integration controls who holds it.`: choose another role for that option.
- `This Confirm no longer matches your latest /setup...`: the button is over an hour old, someone ran `/setup` again since, or another member clicked it. Run `/setup` again.
- `Someone else changed the roles...`: another admin saved first. Run `/setup` again.
- `Something went wrong...`: the bot could not reach the database. Check that `DATABASE_URL` is `bot_app`'s string, that the password in it is the one set with `ALTER ROLE bot_app PASSWORD`, and that the migrations ran. Logs show `Invalid configuration for DATABASE_URL` if the setting is empty.

Every command except `/ping` and `/setup` refuses until this is done. If the roles change later, run `/setup` again with all five. A server set up before these roles existed keeps its Events Directors and admin roles, and `/config` says `Run /setup to choose the ... role` for each one still missing. While its admin role differs from E-board, `/config` shows it on its own `Admin:` line.

### `/config`

Run `/config`.

**Expect:** a private panel showing reminders on, the five roles as mentions that ping nobody, with E-board shown as `E-board (also admin)`, no managed forums and one recent change.

Choose `test-events` in **Add a managed forum**.

**Expect:** `Added` and the forum listed. A note beside it says if `@everyone` can view the forum.

**Failure looks like:**

- `The bot is missing these permissions in that forum: ...`: go back and grant them.
- `Discord would not confirm that forum...`: the bot could not check. Try again, and see the staging checklist if it continues.

The bot posts only in managed forums. The **Turn reminders off** button is also the kill switch for reminders. Turning them back on after that day's run, around 15:00 UTC, does not reopen it: they resume with the next day's run, and the panel says so.

### A first event and task

Give yourself `Test Events Directors`, then run `/event create` with a made-up name and a date as `YYYY-MM-DD` or `MM/DD`.

**Expect:** `Created ...`, and a new post in `test-events` with the event's overview.

Run `/task assign` inside that post, choosing your second account, a made-up description and a due date.

**Expect:** a private confirmation, and a public message in the post that pings only that person, with a Mark done button. The overview updates to show the task.

**Failure looks like:**

- `No forums are managed yet...`: add the forum in `/config`.
- `I'm not allowed to post in that forum...`: go back and check the forum's permissions.
- `That forum requires a tag on every post...`: turn the requirement off.
- `You can't do that, or it doesn't exist.`: you do not hold the Events Directors or E-board role.

### The event's steps

This needs the Treasury Committee and Marketing Committee roles chosen in `/setup`. Give your second account a role that is neither.

Run `/event create` again with another made-up name, and choose your second account in the `budget` option.

**Expect:** the reply names your second account on Budget Sheet. The new post's overview has a **Checklist** with four lines, your second account shown on Budget Sheet, and three buttons: **Budget Sheet done**, **Engage post done** and **Budget approved**. Nobody is notified by the overview.

As your second account, click **Engage post done**, then **Budget Sheet done**.

**Expect:** the first click gets a private `You can't do that, or it doesn't exist.`, because that account is not on Engage post. The second gets a private `Marked Budget Sheet done ...`. One message appears in the post pinging the Treasury Committee role, and the overview shows Budget Sheet ticked and loses its button. Click **Budget Sheet done** again: the reply says it is already done, and nothing more is posted.

As your second account, click **Budget approved**.

**Expect:** the fixed refusal, because only officers and the Treasury Committee can approve.

As yourself, run `/event pickup` with `time:5:30 PM` and `/event assign` with `step:Food pickup` and your second account, in the post.

**Expect:** both work before the budget is approved. The overview shows Food pickup ticked, at 5:30 PM, with your second account. As your second account, `/mytasks` lists that food pickup.

Click **Budget approved**.

**Expect:** a message in the post saying the budget is approved, which pings nobody, and the overview shows Budget approved ticked.

**Failure looks like:**

- `Budget Sheet for ... is done. Run /setup to choose the Treasury Committee role...` in the post: the role is not chosen yet. Run `/setup` again.
- The buttons do nothing for anyone: check that the interactions endpoint is still set, as in Part 6.

## Part 9: Add flood protection and usage alerts

A flood of requests can use up Hobby's monthly limits, and in most cases you then wait 30 days. Denied requests do not count against CDN or data transfer usage.

### Firewall rules

Hobby allows 3 custom rules, of which 1 may be a rate limit. Rules apply to the production deployment. Add them under Firewall > Configure, each first with action **Log**. Watch the traffic for at least 10 minutes, including a `/ping`, then change to the final action and publish.

| Rule                 | If                                                                      | Then                            |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Only known paths     | Path is not `/api/interactions`, `/api/cron/reminders` or `/robots.txt` | Deny                            |
| Signed requests only | Path is `/api/interactions` and header `x-signature-ed25519` is missing | Deny                            |
| Rate limit by IP     | Path is `/api/interactions`                                             | Rate limit, 100 per 60 s, by IP |

The operator names were not in the docs as rendered, so check them in the dashboard.

The rate limit must leave room for Discord, whose requests come from its own servers. One club's traffic should be far below 100 a minute, but watch for it while the rule is on Log. If commands start failing with "did not respond" while the rule shows blocks, raise the limit.

These rules reduce a flood. They do not stop one from many addresses with made-up signature headers. Those still reach the function and get a 401.

### Usage alerts

Hobby's usage notifications are automatic and their thresholds cannot be changed. Custom alerts need a paid plan.

1. Under Settings > My Notifications, confirm "Usage increased" and "Usage limit reached" are on, by email.
2. Look at the Usage page weekly for the first month, set to the last 30 days.
3. In Neon, check the project's storage and compute use on its usage page each month.

Nothing here costs money unless you add a payment method. Think again before you do.

## Part 10: Test everything

Work through [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) on the test setup. Do not start production until it is complete, or you have written down why you accept each open item.

## Part 11: Production

Repeat the parts above with new values. Each row is a real difference.

| Part | Do this                                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3    | Create the real app, with its own token. Consider a team now, see the note below.                                                                                                                                                                                    |
| 4    | Create the production Neon project. Run `pnpm db:migrate` with its owner's connection string, and read the host in that string first, so you do not migrate the wrong project. Give `bot_app` its own new password.                                                  |
| 5    | Create a second Vercel project on the same repository. Leave the production branch as `main`. Generate a new cron secret. Set `DATABASE_URL` to the production `bot_app` string and `ALLOWED_GUILD_IDS` to the club's server only. No value may match the test ones. |
| 6    | Use the production project's domain and the real app.                                                                                                                                                                                                                |
| 7    | Invite to the club's server as the app owner, which needs Manage Server there. Grant permissions on each real forum. Register with the real app's values in `.env`, then delete `.env`.                                                                              |
| 8    | Run `/setup` with the club's five roles. Run `/config` and add the real forums.                                                                                                                                                                                      |
| 9    | Add the same firewall rules. They do not copy between projects.                                                                                                                                                                                                      |

`vercel.json` applies to both projects, so the production project also builds `staging`, as a preview. That preview has no settings, because they exist only in Production, and Standard Protection hides it.

**Teams.** A Discord app can move to a team, which lets a second person act if you are unavailable. A team has only one owner, so add the second person as an admin. The move cannot be undone. See [HANDOFF.md](HANDOFF.md).

**Before you switch reminders on for real people,** run `/config`, confirm reminders are set as you want, and tell the club's officers that the kill switch exists.

## Part 12: Backups

Neon keeps the database's recent history, so a branch can be restored to an earlier moment within the plan's restore window. On the production project, check how long that window is, as [RECOVERY.md](RECOVERY.md) says. On the Free plan it is short, so the manual export is what reaches further back.

Once `/setup` has run, take the first manual export from [RECOVERY.md](RECOVERY.md#a-manual-export) and store it privately. Rehearse a restore on the test project before real data arrives.

## When you are done

- Delete `.env` from your computer unless you are about to register commands again.
- Keep a private note of which account owns what, somewhere the next maintainer can find it.
- Update the status line in `README.md`.
