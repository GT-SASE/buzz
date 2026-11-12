# Handoff

Student maintainers graduate. This guide moves the bot to the next person without losing access or data, and without leaving the old maintainer able to reach it.

Start at least a month before the outgoing maintainer leaves. Do it together, on a call for the parts that need both people. Dashboards change, so where this says **check this in the dashboard**, the official docs did not confirm the step.

## The order

1. The incoming maintainer secures their accounts.
2. A fresh manual export is taken, so nothing is lost if a step goes wrong.
3. Move each account.
4. Rotate every secret.
5. Delete old deployments and remove the outgoing maintainer.
6. Test the bot, then write down the date.

## Step 1: Secure the new accounts

The incoming maintainer follows Part 1 of [SETUP.md](SETUP.md) on all four accounts. Use a long-lived personal email for recovery, not a university address.

## Step 2: Take an export first

The outgoing maintainer takes a manual export, as in [RECOVERY.md](RECOVERY.md#a-manual-export), and keeps it until Step 6 is done. Restores come from Neon's own history.

## Step 3: Move each account

### GitHub

1. Move the main repo under Settings > General > Danger Zone > Transfer ownership. The new owner accepts by email. Check this in the dashboard.
2. The incoming maintainer clones the repo, then runs `pnpm install --frozen-lockfile`, `pnpm gitleaks:install` and `pnpm hooks:install`. Confirm `git config user.email` shows their noreply address.
3. They also set up the clone's local excludes, as in "Before you start" in [SETUP.md](SETUP.md). The list belongs to one clone, so the outgoing maintainer passes on theirs privately, and it should not go in this repo. They can print it with `cat "$(git rev-parse --git-path info/exclude)"`.

The repository is public, so Vercel Hobby can deploy it from a personal account or an organisation. Check this in the dashboard before moving it to an organisation.

**Failure looks like:** a repo that Vercel can no longer see after the transfer. The Vercel part below replaces that link.

### Neon

The incoming maintainer needs this before the Vercel part, to set the new `bot_app` password.

1. Add the incoming maintainer to the Neon projects, through an organisation or the project's sharing settings, whichever the plan offers. Check this in the dashboard.
2. They accept, then confirm they can open both projects, the SQL editor and the Connect dialog.
3. Remove the outgoing maintainer last, after Step 5.

If the incoming maintainer wants the projects under their own account, Neon may allow transferring a project. Check this in the dashboard. A project cannot change region this way.

### Discord

The incoming maintainer needs this before the Vercel part, to reset the token and change the endpoint URL.

A Discord app cannot be given directly to a person. It must go through a team, and that move is permanent.

1. If the apps are not on a team, the outgoing maintainer creates one on the Teams page, then uses **Transfer App to Team** on each app's General Information page. Creating or joining a team requires two-factor authentication.
2. Invite the incoming maintainer as an admin.
3. Hand over team ownership. A team has one owner. Discord's docs do not describe how to transfer it, so check this in the portal.
4. Confirm that the incoming maintainer can see the Bot page and the Interactions Endpoint URL.

Do not invite the bot again. It stays in the club's server. If the club's roles changed, an Administrator runs `/setup` again.

Check the server side too. Ask who holds Administrator, Manage Roles and the five bound roles, and remove anyone who has left.

### Vercel

**Why Hobby has one owner.** A Hobby account belongs to one person and has no team members, so the bot cannot be shared with a co-owner on Hobby. The new maintainer needs their own Vercel projects, or a paid team. Check in the dashboard whether Vercel still requires a deployed commit's author to be the account's owner.

Vercel's project transfer needs the sender to own the source team and be a member of the target team. Two separate Hobby accounts do not appear able to meet that, so this guide recreates the projects. Check this in the dashboard. A Pro team could hold both people, and would cost money.

The steps, for test first, then production:

1. On the old project, use Settings > Cron Jobs > Disable Cron Jobs. Otherwise both projects will run the daily job.
2. The incoming maintainer creates a new project from the transferred repo, as in Part 5 of [SETUP.md](SETUP.md), including the production branch, Standard Protection and firewall rules.
3. The incoming maintainer generates the first three secrets in the Step 4 table now, and adds them to the new project with the other settings. Do not copy old values. A new `bot_app` password cuts off the old project's database access at once, and so does resetting the bot token, so its posts and reminders fail from then on. Do this together, and go straight on to steps 4 and 5.
4. Push a commit authored by the incoming maintainer, so that Vercel accepts the deployment.
5. Change the Interactions Endpoint URL in Discord to the new domain, and test `/ping`.
6. Delete the old project. This removes its deployments and their stored settings.

A project's name decides its URL. The old name stays taken until the old project is deleted, so expect a new URL.

**Failure looks like:** a deployment blocked for its commit author. The newest commit must be authored by the new owner, and their Vercel account must be linked to their GitHub.

## Step 4: Rotate every secret

Do this even if nobody has done anything wrong. The outgoing maintainer knew every value. The incoming maintainer generates them, and the outgoing one never sees them.

The first three rows were generated for the new Vercel project in Step 3. Finish them here. If a value is set after a deployment, redeploy, because a deployment does not pick up new values.

| Secret                                | Where                                                                                     | Then                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                   | Developer Portal > Bot > Reset Token                                                      | Set in Vercel and redeploy. Reset cuts off the old one at once.                                   |
| `DATABASE_URL` (`bot_app`'s password) | `openssl rand -hex 32`, then as the owner `ALTER ROLE bot_app PASSWORD '<new password>';` | Put the new password in `DATABASE_URL` in Vercel and redeploy. The old one stops working at once. |
| `CRON_SECRET`                         | `openssl rand -hex 32 \| tr -d '\n'`                                                      | Set in Vercel and redeploy.                                                                       |
| The owner role's password             | Neon console, on the project's roles                                                      | Store it in the password manager only.                                                            |
| Personal tokens                       | GitHub, Vercel and Neon account settings                                                  | The outgoing maintainer deletes any made for this bot.                                            |

Do this for the test and production columns. Use different values in each.

`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `ALLOWED_GUILD_IDS` and `ENABLE_EXPERIMENTAL_COREPACK` are not secret and stay the same.

The outgoing maintainer also deletes any local `.env`, clones holding real data, and manual exports, and removes secrets from their password manager once this is finished.

## Step 5: Clean up

1. If you kept any old Vercel project, delete every deployment made before the rotation, as described in [SECURITY.md](../SECURITY.md). Old deployments may hold old values.
2. Remove the outgoing maintainer from the Neon projects, the Discord team and the GitHub repo.
3. Check that no Vercel integration or GitHub app remains from the old account.

## Step 6: Test, and record it

1. Run `/ping`, `/config` and `/mytasks`.
2. Run these against the new domain and confirm 401 for the first and `ok` for the second, after setting `URL` and `CRON` in your terminal:

   ```sh
   curl -i "$URL/api/cron/reminders"
   curl -i -H "Authorization: Bearer $CRON" "$URL/api/cron/reminders"
   ```

3. Confirm that the old values fail: logging in with the old `bot_app` password is refused, and the old cron secret gets a 401 from the new project.
4. Check `job_runs` for a good reminder run the next day, and Neon's restore window. A run can succeed and still leave something for you to look at: in its `results`, `threads_held` counts events whose post refused the bot, and `held_event_ids` lists up to 25 of them.
5. The incoming maintainer takes their own manual export. The outgoing one then deletes theirs.
6. Write the date somewhere the next maintainer will find it. Keep that note out of this repo if it names people.

## Yearly review

Once a year, ideally when officers change, the current maintainer checks:

**Accounts**

- [ ] All four accounts still have working two-factor methods, and the recovery codes are where you think they are.
- [ ] Recovery emails still work and will keep working after graduation.
- [ ] GitHub SSH keys, tokens and authorised apps are all still needed. Check the same on Vercel and Neon.
- [ ] Vercel Hobby's non-commercial terms still fit how the club uses the bot.

**Access**

- [ ] The list of people holding Administrator, Manage Roles and the five bound roles is short and current. Discord's audit log keeps entries for 45 days only, and the bot is not told about grants. Do this each term if you can.
- [ ] A second trusted officer who can reach the manual exports is still reachable, and is still the right person.
- [ ] The Discord team and the Neon projects hold only current people.

**Recovery**

- [ ] Neon's restore window is what you expect for the plan. See [RECOVERY.md](RECOVERY.md).
- [ ] A manual export was taken this term, and older ones beyond the last two are deleted.
- [ ] A restore was rehearsed on the test project this year.

**Service**

- [ ] Usage is well below Vercel's and Neon's limits, and the database has room. `history.row_versions` has no retention, so it only grows.
- [ ] Dependabot pull requests have been reviewed, not left open.
- [ ] Only the owner and `bot_app` can log in to the Neon projects, and `bot_app` still has only its grants: run the first two items of the Neon section of [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md). Platform changes may alter defaults.
- [ ] Firewall rules are still in place. Delete stale deployments you do not need for rollback.
- [ ] Rotate `CRON_SECRET`, the bot token and `bot_app`'s password if the year has seen any doubt about them.
- [ ] Read `SECURITY.md` and this guide, and fix anything that has gone out of date.
