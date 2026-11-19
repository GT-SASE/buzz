# Moving the bot into buzz

The bot can move into the [buzz](https://github.com/GT-SASE/buzz) repository as `sites/discord-bot`, keeping its history. It stays its own project there: its own `bun.lock`, its own install, and its own Vercel project. It does not become one of buzz's Bun workspaces.

## Why not a workspace

buzz installs with Bun's isolated linker, which puts each package in `node_modules/.bun/` and links it into each workspace. Vercel's function file tracing copies the packages but not those links. A function built from inside buzz's workspace therefore deploys without its dependencies, and fails to start with `Cannot find package '@vercel/functions'`. The same build also reports TypeScript errors such as `Property 'headers' does not exist on type 'Response'`.

This was tested on 2026-11-15 with Vercel CLI 65.4.0 and 65.16.0, on Linux:

- Built as a buzz workspace, the bundle copied out of the repository failed to import, with either CLI.
- An `installCommand` with `--linker hoisted`, in `vercel.json` or in the project settings, did not help, because the Node builder runs its own `bun install`. `BUN_CONFIG_LINKER=hoisted` did not help either.
- With buzz's root `bunfig.toml` set to the hoisted linker, the bundle worked. buzz uses the isolated linker on purpose, so that is not the fix.
- Built from `sites/discord-bot` alone, with its own lockfile, the bundle worked: both functions loaded outside the repository and answered 401 to an unsigned request, with no TypeScript errors.

Revisit this if Vercel's tracing learns to follow Bun's isolated links.

## Steps, in buzz

Do these on a branch in buzz, then open a pull request. Steps 1 to 3 were tried on a copy of buzz. Steps 4 to 6 need GitHub and Vercel and were not, so check the first deploy against [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md).

1. Bring in the bot with its history:

   ```sh
   git subtree add --prefix=sites/discord-bot git@github.com:GT-SASE/discordBot.git main
   ```

2. Keep it out of buzz's workspaces. In buzz's root `package.json`:

   ```json
   "workspaces": ["packages/*", "sites/*", "!sites/discord-bot"]
   ```

   Then run `bun install` at the root. buzz's `bun.lock` should come out unchanged. Install the bot separately with `bun install --frozen-lockfile` in `sites/discord-bot`.

3. Keep buzz's root ESLint off the bot, which lints itself with its own config. Add `"sites/discord-bot/**"` to the `ignores` in buzz's `eslint.config.ts`. Without it, buzz's `bun run lint` fails with 7582 errors, because typescript-eslint finds two candidate `tsconfigRootDir`s.

4. Move the bot's CI into buzz's `.github/workflows/`. GitHub reads workflows only at the repository root, so the files under `sites/discord-bot/.github/` stop running. Give each moved job `defaults.run.working-directory: sites/discord-bot` and a `paths` filter on `sites/discord-bot/**`, and keep the Postgres 17 job from `db.yml`. The gitleaks job scans the whole repository, so decide whether buzz wants that for every commit.

5. Move `sites/discord-bot/.github/dependabot.yml` into buzz's, as a `bun` entry with `directory: /sites/discord-bot`, and delete the copy.

6. Point the bot's existing Vercel project at buzz:
   - Root Directory: `sites/discord-bot`.
   - Turn off including files outside the Root Directory, so the build sees only the bot and installs from its lockfile.
   - Set the Ignored Build Step to `git diff --quiet HEAD^ HEAD -- .`, so a change to buzz alone does not redeploy the bot.
   - Environment variables and the crons in `vercel.json` stay as they are.

7. Delete `sites/discord-bot/.github/`, then archive the discordBot repository.

## What keeps working where it lands

- `bun run check`, the tests and `turbo` run from `sites/discord-bot` with the bot's own `turbo.json`.
- `bunfig.toml` still applies, since the bot installs on its own.
- `.gitignore`, `.gitattributes` and `.vercelignore` apply to their own directory.
- `hooks:install` sets the hook path from wherever it runs, so in buzz it points at `sites/discord-bot/.githooks`. The pre-push hook then scans every commit pushed to buzz with the bot's gitleaks rules.

buzz's root `lint`, `format:check`, `typecheck` and `typecheck:tsc` pass with the bot in place, not installed, and step 3 applied. buzz runs Bun 1.4.3 and the bot pins 1.4.4. Each installs with its own version, and both deploy on Vercel's `1.4.x` runtime.
