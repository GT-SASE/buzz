# Setup

The steps to set the bot up from nothing, on the club's own new Discord, Neon and Vercel accounts. You make one Discord app, one Neon project and one Vercel project, which deploys `main`. You first point it at a private test server, run the smoke checks there, then add the club's server.

Dashboards move. Where a step says **check this in the dashboard**, the label or place was not confirmed, so look for it and note any difference here.

## Before you start

You need:

- A Mac or Linux computer with Bun 1.4.4, Git, Bash, curl, OpenSSL and `psql` 16 or later.
- A password manager, and a passkey or security key.
- A second Discord account, to act as an ordinary member.
- Administrator on the club's server, or someone who has it.

Get the code and check it:

```sh
git clone <repository-url>
cd <repository-folder>
bun install --frozen-lockfile
bun run gitleaks:install
bun run hooks:install
bun run typecheck && bun run lint && bun run test
```

**Expect:** the checks pass.

Keep your own tools' files out of Git. For each one, run `printf '%s\n' '<file>' >>"$(git rev-parse --git-path info/exclude)"`.

## 1. Secure the four accounts

Use a long-lived personal email for recovery, not a university one, and save every recovery code in the password manager.

- **GitHub:** under Settings > Password and authentication, turn on two-factor authentication and add a passkey. Under Settings > Emails, turn on "Keep my email addresses private" and "Block command line pushes that expose my email". Then `git config user.email` must show your GitHub noreply address.
- **Discord:** under User Settings > My Account, register a security key, and save the backup codes.
- **Vercel:** sign up with your GitHub account, because Hobby checks that a commit's author is the account's owner. Add a passkey and two-factor authentication under Account Settings > Authentication.
- **Neon:** sign up with your GitHub account. Turn on Neon's own two-factor option if there is one. Check this in the dashboard.

## 2. Create a private test server

1. In Discord, turn on User Settings > Advanced > Developer Mode.
2. Create a server of your own, and invite only your second account.
3. Create five roles with no extra permissions: `Test E-board`, `Test Events Directors`, `Test Events Committee`, `Test Treasury` and `Test Marketing`.
4. Create a forum channel called `test-events`. If the option is missing, turn on Community in Server Settings.
5. Right-click the server icon, choose Copy Server ID and keep it.

## 3. Create the Discord app

1. In the Discord Developer Portal, choose **New Application**.
2. On General Information, copy the Application ID and the Public Key. Neither is secret.
3. On the Bot page, choose Reset Token and save the token in the password manager. Discord shows it once.
4. On the Installation page, set Install Link to **None**, and under Installation Contexts turn **User Install** off.
5. On the Bot page, turn **Public Bot** off. Leave **Requires OAuth2 Code Grant** and all three privileged gateway intents off. Save.

**Failure looks like:** "Private application cannot have a default authorization link". Set Install Link to None first.

Do not set the Interactions Endpoint URL yet.

## 4. Create the Neon project

Create a project on the Free plan with Postgres 17, in an AWS US East region, close to Vercel's default function region, Washington, D.C. (`iad1`). Neon makes a database, `neondb`, and an owner role, `neondb_owner`. Save the owner's password in the password manager.

### Run the migrations

In the project's **Connect** dialog, choose `neondb_owner` and the database, and turn connection pooling off. Change `sslmode=require` at the end to `sslmode=verify-full`. Then paste that string at the prompt:

```sh
read -rs OWNER_URL
DATABASE_URL="$OWNER_URL" bun run db:migrate
```

**Expect:** `Applying:` and `Applied:` for each file in `db/migrations`. Run it again and it prints nothing.

**Failure looks like:** `permission denied`. Use the project's owner role, never `bot_app`.

### Set `bot_app`'s password

The migrations create `bot_app`, the role the bot logs in as, with no password. Make one with `openssl rand -hex 32` and save it. Then as the owner, in `psql "$OWNER_URL"`, run `\password bot_app` and paste it, or run this in Neon's SQL editor:

```sql
ALTER ROLE bot_app PASSWORD '<password>';
```

### Build the bot's connection string

It has this shape, with the host and database from the Connect dialog:

```text
postgresql://bot_app:<password>@<host>/<database>?sslmode=verify-full
```

A hex password needs no encoding. Save the string in the password manager, then check it:

```sh
read -rs BOT_URL
psql "$BOT_URL&sslrootcert=system" -c 'SELECT current_user;'
unset OWNER_URL BOT_URL
```

**Expect:** `bot_app`.

**Failure looks like:** `password authentication failed`. Check the password and its encoding.

## 5. Create the Vercel project

1. Choose **Add New** > **Project** and import the GitHub repository, giving Vercel access to this repository only.
2. Choose a name. It becomes the public URL `<name>.vercel.app`.
3. Leave the framework as Other and the root directory as it is. `vercel.json` sets the rest, and deploys `main` only.
4. Deploy. With no settings yet, every request fails. That is fine.
5. Check that Settings > Environments > Production > Branch Tracking says `main`.

**Failure looks like:** a deployment blocked for its commit author. The author must be the Vercel account's owner.

### Generate the cron secret

```sh
openssl rand -hex 32 | tr -d '\n' | pbcopy
```

This copies 64 characters with no newline on a Mac. On Linux, leave off `| pbcopy` and copy only the 64 characters.

### Add the settings

Under Settings > Environment Variables, add each with **Production** as the only environment:

| Name                 | Type   | Value                                      |
| -------------------- | ------ | ------------------------------------------ |
| `DISCORD_APP_ID`     | Config | The Application ID                         |
| `DISCORD_PUBLIC_KEY` | Config | The Public Key                             |
| `DISCORD_BOT_TOKEN`  | Secret | The bot token                              |
| `ALLOWED_GUILD_IDS`  | Config | The test server's ID                       |
| `DATABASE_URL`       | Secret | `bot_app`'s connection string, from step 4 |
| `CRON_SECRET`        | Secret | The value you just generated               |

Never put the owner's connection string in Vercel.

### Turn on Deployment Protection

Under Settings > Deployment Protection, turn on Vercel Authentication with **Standard Protection**. Do not choose All Deployments, which blocks Discord too, and do not create a Protection Bypass for Automation or shareable links.

### Redeploy and test

Redeploy from the Deployments page, because a deployment only picks up settings made before it.

**Expect:** the deployment reaches Ready, and Settings > Cron Jobs lists `/api/cron/reminders` twice.

```sh
curl -i https://<name>.vercel.app/robots.txt
curl -i -X POST https://<name>.vercel.app/api/interactions
curl -i https://<name>.vercel.app/api/cron/reminders
```

**Expect:** 200, then 401 `invalid request signature`, then 401 `unauthorized`. Logs show no `Cron secret is unset or too short`.

**Failure looks like:** a Vercel login page. Use the production domain, not a deployment's own URL.

## 6. Connect Discord

On the app's General Information page, set Interactions Endpoint URL to `https://<name>.vercel.app/api/interactions` and save.

**Expect:** it saves.

**Failure looks like:** "could not be verified". Check that `DISCORD_PUBLIC_KEY` is this app's and was set before the last deployment, and that Logs show no `Invalid configuration for DISCORD_PUBLIC_KEY`.

## 7. Invite the bot and register commands

1. On the app's OAuth2 page, open the URL Generator. Choose the scopes `bot` and `applications.commands` and tick no permissions. The URL must contain `permissions=0`.
2. Open the URL and choose the test server. The bot joins and shows as offline, which is normal.
3. On `test-events`, open Edit Channel > Permissions, add the bot, and allow only View Channel, Send Messages and Send Messages in Threads. Discord may call the last two Create Posts and Send Messages in Posts. Leave Manage Threads off.
4. Register the commands:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   Fill in `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN` and `ALLOWED_GUILD_IDS`, then run:

   ```sh
   bun run commands:register <test-server-id>
   ```

**Expect:** `Registered N command(s) in server <id>`. Then `/ping` in the test server replies `Pong!`. Register again whenever the commands change.

| Failure                               | Meaning                                 |
| ------------------------------------- | --------------------------------------- |
| `... is not in ALLOWED_GUILD_IDS`     | The ID differs from `ALLOWED_GUILD_IDS` |
| `Discord answered 401 for server ...` | The token is wrong or was reset         |
| `Discord answered 403 for server ...` | The bot has not joined that server      |
| `Invalid configuration for ...`       | That setting is missing or malformed    |

## 8. Run `/setup` and `/config`

As a server Administrator, run `/setup` and choose a role for each option, then click Confirm within an hour:

| Option                  | Role                    |
| ----------------------- | ----------------------- |
| `eboard_role`           | `Test E-board`          |
| `events_directors_role` | `Test Events Directors` |
| `events_committee_role` | `Test Events Committee` |
| `treasury_role`         | `Test Treasury`         |
| `marketing_role`        | `Test Marketing`        |

**Expect:** `Saved.` and the five roles.

Then run `/config` and choose `test-events` in **Add a managed forum**.

**Expect:** `Added` and the forum listed.

**Failure looks like:** `The bot is missing these permissions in that forum: ...`. Grant them as in step 7.

## 9. Add flood protection and usage alerts

Under Firewall > Configure, add these rules, each first with action **Log**. Watch the traffic for 10 minutes, including a `/ping`, then set the final action and publish. Check the operator names in the dashboard.

| Rule                 | If                                                                      | Then                            |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Only known paths     | Path is not `/api/interactions`, `/api/cron/reminders` or `/robots.txt` | Deny                            |
| Signed requests only | Path is `/api/interactions` and header `x-signature-ed25519` is missing | Deny                            |
| Rate limit by IP     | Path is `/api/interactions`                                             | Rate limit, 100 per 60 s, by IP |

Under Settings > My Notifications, keep "Usage increased" and "Usage limit reached" on.

## 10. Run the smoke checks

Work through [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) on the test server. Do not add the club's server until every check passes, or you have written down why you accept a failure.

## 11. Add the club's server

1. Add the club server's ID to `ALLOWED_GUILD_IDS`, comma-separated, and redeploy. Keep the test server's ID if you want to run smoke checks there later.
2. As the app's owner, with Manage Server on the club's server, invite the bot with the same URL as in step 7.
3. Grant the three permissions on each forum the bot should post in.
4. Put the club server's ID in `.env`, run `bun run commands:register <club-server-id>`, then delete `.env`.
5. Run `/setup` with the club's five roles, and add the forums in `/config`.
6. Tell the officers that **Turn reminders off** in `/config` stops all reminders.

To let a second person act on the Discord app, move it to a team, as [HANDOFF.md](HANDOFF.md) says.

## 12. Backups

1. Write down Neon's restore window for the project, as [RECOVERY.md](RECOVERY.md) says.
2. Once `/setup` has run, take the first [manual export](RECOVERY.md#a-manual-export) and keep it private.
3. Rehearse restoring it into a new, empty Neon project before real data arrives.

## When you are done

- Delete `.env` unless you are about to register commands again.
- Keep a private note of which account owns what, where the next maintainer can find it.
- Update the status line in `README.md`.
