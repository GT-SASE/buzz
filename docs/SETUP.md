# Setup

This guide takes you from nothing to the bot working on a private test server, then to production. It assumes you have not used Discord's developer tools, Vercel or Supabase before.

Do the steps in order. Each one says what to expect and what a failure looks like.

The docs for these services were last checked on 2026-11-04, and dashboards move. Where a step says **check this in the dashboard**, the official docs did not confirm the exact label or location, so look for it and note any difference here.

## What you will end up with

|                   | Test                | Production         |
| ----------------- | ------------------- | ------------------ |
| Discord app       | Test app            | Real app           |
| Discord server    | Private test server | The club's server  |
| Supabase project  | Test project        | Production project |
| Vercel project    | Test project        | Production project |
| Production branch | `staging`           | `main`             |
| Secrets           | Used only here      | Used only here     |

Never reuse a key, token or password between the two columns.

## Before you start

You need:

- A Mac or Linux computer with Node.js 24, Git, Bash, curl 7.71 or later and OpenSSL.
- A password manager.
- A passkey or hardware security key, plus a second one as a backup if you can.
- A second Discord account, to act as an ordinary member. A friend's account is fine.
- Administrator on the club's server for the production part, or someone who has it and can help.

The bot is deployed from `main` and `staging`. Everything you want to run must be merged first. Then get the code and check it:

```sh
git clone <repository-url>
cd <repository-folder>
npm ci --ignore-scripts
npm run gitleaks:install
npm run hooks:install
npm run typecheck && npm run lint && npm test
ls supabase/migrations | cut -c1-14 | sort | uniq -d
```

**Expect:** the checks pass and the last command prints nothing.

**If the last command prints a number:** two migrations share a version, and `supabase db push` cannot apply them safely. Stop and rename the later one before going on.

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

### Supabase

**Supabase does not offer a passkey or hardware key for its own login.** Its docs list only authenticator app codes (TOTP), and it gives no recovery codes.

1. Open your account settings and turn on multi-factor authentication.
2. Register a second factor on a different device or app. Supabase says it cannot restore access if you lose them all.

Check this in the dashboard in case passkeys have been added since.

## Part 2: Create the test server

1. In Discord, turn on User Settings > Advanced > Developer Mode, so you can copy IDs.
2. Click **+** in the server list and create your own server. Do not invite anyone yet.
3. Create two roles: `Test Officer` and `Test Admin`. Give them no extra permissions.
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

## Part 4: Create the test Supabase project

Create an organisation if asked, then a new project on the Free plan. Save the database password in the password manager. Choose a region close to Vercel's function region. Slow database reads can exceed the 1.5 seconds the bot allows before replying.

### Create the secret key

Go to Settings > API Keys and create a secret key. It starts with `sb_secret_`. Store it in the password manager. This is the only key the bot uses.

### Turn off what the bot does not use

1. **Legacy keys.** On Settings > API Keys, deactivate the legacy `anon` and `service_role` keys. They stay valid until you do this, even after you create new ones. Nothing here uses them, and this can be undone.
2. **GraphQL.** Go to Database > Extensions and turn `pg_graphql` off. It may already be off on a new project.
3. **Open sign-ups.** Go to Authentication > Sign In / Providers and turn off "Allow new users to sign up". Check this in the dashboard.
4. **Exposed schemas.** Open the Data API settings, under Settings > API or Integrations > Data API. Exposed schemas must list `public` only. The `history` schema must never be listed. Turn off **Automatically expose new tables** if you see it. Check this in the dashboard.

**Failure looks like:** a key you meant to turn off still reading data, when you test it in the staging checklist.

### Run the migrations

Install the Supabase command line tool, sign in and connect it to this project. The project ref is on Settings > General, and it also appears in the project's URL.

```sh
brew install supabase/tap/supabase
supabase --version
supabase login
supabase link --project-ref <test-project-ref>
supabase db push --remote --dry-run
```

The link step asks for the database password.

These steps were written for Supabase CLI 3.0.0. From that version `db push` and `migration repair` use a local stack unless you pass `--remote`, even after `link`. Without it, the push fails with a connection error to `127.0.0.1:54322`. If a local stack is running, it reports success against the wrong database. If the CLI rejects `--remote`, it is older, so run `brew upgrade supabase`. Note the version you used here if it differs.

**Expect:** the first line of output starts with `Target:` and names this project, not `local stack`. Stop if it says `local stack`. The exact wording for a linked project has not been seen, because these commands have not been run against a hosted project, so correct this line when you see it. The dry run then lists every file in `supabase/migrations`, in order. If it looks right, apply them:

```sh
supabase db push --remote
```

**Expect:** the same `Target:` line, each migration reported as applied, and Table Editor showing `guild_config`, `events`, `tasks` and others, all empty.

**If it fails:**

- It stops at the failing migration. Read the error, fix the cause and run it again. Do not use `--include-all`.
- An error mentioning `backup_ro` and `BYPASSRLS` needs [BACKUPS.md](BACKUPS.md). That migration expects either success or error code `42501`.
- The repo has no `supabase/config.toml`. Supabase's docs say only `supabase start` needs it, but this has not been tried here. If `link` or `db push` asks for it, run `supabase init` and do not commit the file it creates.

Then open Advisors > Security in the dashboard and read each finding. "RLS enabled, no policy" is expected, because the bot's role is limited by grants.

## Part 5: Deploy the test project on Vercel

### Create the project

1. Choose **Add New** > **Project** and import the GitHub repository. Give Vercel access to this repository only.
2. Name the project without the club's name, because the name becomes a public URL: `<name>.vercel.app`.
3. Leave the framework as Other and the root directory as it is. `vercel.json` sets the rest.
4. Deploy. The first deployment builds `main` and has no settings, so every request to it fails. That is fine.

**Failure looks like:**

- "Hobby accounts are limited to daily cron jobs": a schedule in `vercel.json` runs more than once a day.
- A blocked deployment naming the commit author: the commit's author must be the Vercel account's owner. Check your Login Connections and `git config user.email`.
- A private repository owned by a GitHub organisation cannot deploy on Hobby. Keep the repository on your personal account.

### Set the production branch

Go to Settings > Environments > Production > Branch Tracking, enter `staging` and save. Older screens have this under Settings > Git.

### Generate the cron secret

```sh
openssl rand -hex 32 | tr -d '\n' | pbcopy
```

This copies exactly 64 characters to the clipboard on a Mac, with no newline at the end. A newline saved in the setting could make every cron request fail with a 401. On Linux, leave off `| pbcopy`, copy only the 64 characters, which your prompt then follows on the same line, and clear your terminal afterwards. The endpoint refuses every request if `CRON_SECRET` is unset or under 32 characters.

### Add the settings

Go to Settings > Environment Variables. Add each one below with **Production** as the only environment. Vercel now calls its write-only type **Secret**, and older docs call it Sensitive.

| Name                  | Type   | Value                                    |
| --------------------- | ------ | ---------------------------------------- |
| `DISCORD_APP_ID`      | Config | Test app's Application ID                |
| `DISCORD_PUBLIC_KEY`  | Config | Test app's Public Key                    |
| `DISCORD_BOT_TOKEN`   | Secret | Test app's bot token                     |
| `ALLOWED_GUILD_IDS`   | Config | Test server ID                           |
| `SUPABASE_URL`        | Config | `https://<test-project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Secret | Test project's `sb_secret_` key          |
| `CRON_SECRET`         | Secret | The value you just generated             |

**Expect:** after saving, a Secret's value can no longer be read in the dashboard.

Do not add a database password or connection string here. The bot does not use one, and it would bypass every grant.

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

**Expect:** a Production deployment of `staging` that reaches Ready. Settings > Cron Jobs lists `/api/cron/reminders` twice, at `0 14 * * *` and `0 16 * * *`.

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
npm run commands:register -- <test-server-id>
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

As a server Administrator, run `/setup` and choose `Test Officer` and `Test Admin`.

**Expect:** a private message showing both roles and which roles may be able to grant them, with a Confirm button. Click it. You should see `Saved.`

**Failure looks like:**

- `You can't do that, or it doesn't exist.`: you do not hold the Administrator permission.
- `Something went wrong...`: the bot could not reach the database. Check `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and that the migrations ran.

Every command except `/ping` and `/setup` refuses until this is done. If the roles change later, run `/setup` again.

### `/config`

Run `/config`.

**Expect:** a private panel showing reminders on, no managed forums and one recent change.

Choose `test-events` in **Add a managed forum**.

**Expect:** `Added` and the forum listed. A note beside it says if `@everyone` can view the forum.

**Failure looks like:**

- `The bot is missing these permissions in that forum: ...`: go back and grant them.
- `Discord would not confirm that forum...`: the bot could not check. Try again, and see the staging checklist if it continues.

The bot posts only in managed forums. The **Turn reminders off** button is also the kill switch for reminders. Turning them back on after that day's run, around 14:00 UTC, does not reopen it: they resume with the next day's run, and the panel says so.

### A first event and task

Give yourself `Test Officer`, then run `/event create` with a made-up name and a date as `YYYY-MM-DD` or `MM/DD`.

**Expect:** `Created ...`, and a new post in `test-events` with the event's overview.

Run `/task assign` inside that post, choosing your second account, a made-up description and a due date.

**Expect:** a private confirmation, and a public message in the post that pings only that person, with a Mark done button. The overview updates to show the task.

**Failure looks like:**

- `No forums are managed yet...`: add the forum in `/config`.
- `I'm not allowed to post in that forum...`: go back and check the forum's permissions.
- `That forum requires a tag on every post...`: turn the requirement off.
- `You can't do that, or it doesn't exist.`: you do not hold the officer role.

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
3. In Supabase, check the project's database size on its usage page each month.

Nothing here costs money unless you add a payment method. Think again before you do.

## Part 10: Test everything

Work through [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) on the test setup. Do not start production until it is complete, or you have written down why you accept each open item.

## Part 11: Production

Repeat the parts above with new values. Each row is a real difference.

| Part | Do this                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3    | Create the real app, with its own token. Consider a team now, see the note below.                                                                                                                                               |
| 4    | Create the production project, with its own password and key. Run `supabase link` to it, confirm with `supabase projects list`, and run `supabase db push --remote --dry-run` and read its `Target:` line before the real push. |
| 5    | Create a second Vercel project on the same repository. Leave the production branch as `main`. Generate a new cron secret. Set `ALLOWED_GUILD_IDS` to the club's server only. No value may match the test ones.                  |
| 6    | Use the production project's domain and the real app.                                                                                                                                                                           |
| 7    | Invite to the club's server as the app owner, which needs Manage Server there. Grant permissions on each real forum. Register with the real app's values in `.env`, then delete `.env`.                                         |
| 8    | Run `/setup` with the club's officer and admin roles. Run `/config` and add the real forums.                                                                                                                                    |
| 9    | Add the same firewall rules. They do not copy between projects.                                                                                                                                                                 |

`vercel.json` applies to both projects, so the production project also builds `staging`, as a preview. That preview has no settings, because they exist only in Production, and Standard Protection hides it.

**Teams.** A Discord app can move to a team, which lets a second person act if you are unavailable. A team has only one owner, so add the second person as an admin. The move cannot be undone. See [HANDOFF.md](HANDOFF.md).

**Before you switch reminders on for real people,** run `/config`, confirm reminders are set as you want, and tell the club's officers that the kill switch exists.

## Part 12: Backups

Follow [BACKUPS.md](BACKUPS.md) from its Setup section. It needs a separate private repository, two key holders and a real restore.

`/setup` must have run first, because the backup job fails until `guild_config` has a row. Do this before real data arrives, and treat the bot as not launched until each key holder has restored a backup.

## When you are done

- Delete `.env` from your computer unless you are about to register commands again.
- Keep a private note of which account owns what, somewhere the next maintainer can find it.
- Update the status line in `README.md`.
