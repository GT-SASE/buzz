# Going public

The repository is private. [Record 1](adr/0001-private-repo-built-to-public-standards.md) says to consider publishing after about a month of working production use.

Going public is one-way. Anything visible can be copied the moment it is visible, so do not skip the review. If you find a problem you cannot fully remove, publish from a new repository instead, as the last section describes.

Where this says **check this in the dashboard**, the official docs did not confirm the step.

## Step 1: Get the club's permission

The repository's name and some files contain the club's name.

Ask the club's leadership whether they agree to be named, and keep their answer in writing. Without a clear yes, go to [Publish from a new repository](#publish-from-a-new-repository), because the name stays in past commits even after a rename.

Find everywhere the name appears:

```sh
git grep -il "<club-name>"
git log --all --oneline -i --grep="<club-name>"
git log --all --oneline -i -G"<club-name>"
```

When this guide was written, the name was in the repository's name and in `package.json`, `package-lock.json`, `.gitleaks.toml`, `.gitleaks-custom.toml`, `scripts/register-commands.ts`, `src/discord/client.ts` and `src/discord/client.test.ts`. The last three use it as part of the bot's `User-Agent`. Git history also holds older files that name it.

Also look for the university's name and any abbreviation of the club or university. A short abbreviation needs a case-sensitive, whole-word search, because ignoring case also matches ordinary code such as `-gt`:

```sh
git grep -nw "<ABBREVIATION>"
```

**Expect:** no matches once the abbreviation has been removed. If there are matches and you have no permission, replace them with a neutral string.

Check the Vercel project names and URLs too, which appear in pull request comments.

## Step 2: Scan the full history

Work in a new clone outside your normal one, so that it starts clean. Fetch the pull request refs, because they keep commits that may no longer be on any branch.

```sh
git clone <repository-url> release-scan
cd release-scan
git fetch origin '+refs/pull/*:refs/remotes/pull/*'
npm ci --ignore-scripts
npm run gitleaks:install
git rev-list --count --all
bash scripts/gitleaks-full-history.sh
```

**Expect:** `No secrets found.`, and a commit count above your branch's, which shows the pull request refs were included.

The script scans contents and messages of every ref with both configurations. It looks for known secret formats, numbers shaped like Discord IDs, and email addresses.

**If it reports a finding:** treat a secret as compromised. Rotate it first by following [SECURITY.md](../SECURITY.md), then publish from a new repository. GitHub's `refs/pull/*` refs are read-only, so you cannot rewrite them yourself.

The scan cannot detect names. Read for those yourself:

```sh
git log --all --format='%an %ae %cn %ce' | sort -u
git log --all --format='%B' | less
git log --all --name-only --format= | sort -u
```

Check that every author is the expected account and every email is a noreply address. Look for real member names, real IDs, personal email addresses and local paths in messages, and for any file that should not exist.

## Step 3: Read the text outside Git

Pull request text, reviews and comments become public too, and the secret scan never saw them. So do Actions logs. Export them outside the clone, and scan and read them.

```sh
mkdir ../release-text
gh pr list --state all --limit 1000 --json number,title,body,comments,reviews > ../release-text/prs.json
gh api --paginate 'repos/{owner}/{repo}/pulls/comments' > ../release-text/review-comments.json
gh api --paginate 'repos/{owner}/{repo}/comments' > ../release-text/commit-comments.json
gh issue list --state all --limit 1000 --json number,title,body,comments > ../release-text/issues.json
.tools/gitleaks dir ../release-text --config .gitleaks.toml --redact
.tools/gitleaks dir ../release-text --config .gitleaks-custom.toml --redact
```

**Expect:** both scans report no leaks. Then **read** all of this by hand. Look for:

- Names of members and officers, and the club's name if you have no permission.
- Screenshots, and any link to a private document.
- Text you would not want an employer or the club to read, or that was written for a private audience.
- Discussion of unfixed weaknesses. Fix them, or decide you accept them.
- Vercel's comments on pull requests, which name project URLs.

Now the Actions logs:

```sh
gh run list --limit 200 --json databaseId,name,createdAt > ../release-text/runs.json
gh run view <run-id> --log > ../release-text/run-<run-id>.log
```

Read a sample of each workflow, and every failed run. Then scan the folder again with the two `gitleaks dir` commands. Also check workflow artifacts, the wiki, releases, repository secrets' names, deployments and Dependabot's pull requests.

If you find something that needs removing, editing a pull request body does not clear its edit history. Publish from a new repository.

Delete `../release-text` when you are finished.

## Step 4: Make the files ready

Do this on a normal branch, through a normal pull request.

1. Add `LICENSE` with the text of the MIT licence and your name as the copyright holder.
2. In `package.json`, change `"license": "UNLICENSED"` to `"license": "MIT"`. Keep `"private": true`, which stops an accidental publish to npm. Run `npm install --package-lock-only --ignore-scripts` to update the lockfile, and check the diff.
3. If you have no permission to name the club, this step is not enough. See the last section.
4. Update the `README.md` status line, and `SECURITY.md`'s text about the repository being private.

## Step 5: Change the visibility

Go to Settings > General > Danger Zone > Change visibility. Do this at a quiet time.

The backups repository stays private, always. Check it has not been changed.

## Step 6: Turn on the protections

These do not work, or are not free, while private. Do them immediately after going public.

**Private vulnerability reporting.** Settings > Advanced Security, in the "Security and quality" section. Click **Enable** next to Private vulnerability reporting. `SECURITY.md` names this as the only reporting route, so do not skip it. Test that the **Report a vulnerability** button shows on the Advisories page.

**Push protection.** On the same page, enable Secret Protection, then click **Enable** next to Push protection.

**CodeQL.** On the same page, click **Set up** next to CodeQL analysis, choose **Default**, then **Enable CodeQL**. Actions must be enabled.

**Ruleset.** Under Settings > Rules > Rulesets, create a branch ruleset for `main` and `staging`. Check this in the dashboard. It should:

- Require a pull request before merging.
- Require the status checks from `ci.yml`, `pr-metadata.yml`, `db.yml` and `deploy-check.yml`, and require the branch to be up to date. First remove `paths-ignore` from `db.yml` and `deploy-check.yml`, and the test that expects it. GitHub never reports a check its workflow skipped, so a docs-only pull request would wait forever.
- Block force pushes and deletions.
- Require linear history.
- Allow no bypass, including for you. If you need one, add it on purpose for one emergency, then remove it.

**Test the ruleset.** Try a direct push to `main` from a test commit.

```sh
git switch main
git pull
git commit --allow-empty -m "test: confirm direct pushes are blocked"
git push origin main
```

**Expect:** the push is refused. Then run `git reset --hard origin/main` to drop that commit.

**If it succeeds:** the ruleset is not active. Revert that commit through a pull request, then fix the ruleset.

## Step 7: Restrict pull requests, and check Dependabot

Anyone can open a pull request on a public repository, and Actions may run on it. Limit this.

1. Under Settings > General > Features, choose **Restrict pull requests to collaborators**, which GitHub's docs also show as a "Collaborators only" dropdown under Pull requests.
2. **Check that Dependabot still works.** GitHub's docs do not say whether this setting affects it. Under Insights > Dependency graph > Dependabot, choose **Check for updates**, or wait for the weekly run. Check this in the dashboard.
3. If Dependabot can no longer open pull requests, decide which you want more. Dependency updates matter, so the likely answer is to undo the restriction and rely on the ruleset instead. Write down the decision.

Also check these:

- Under Settings > Actions > General, fork pull request workflows need approval, and the default `GITHUB_TOKEN` permission is read-only. Check this in the dashboard.
- No repository secret exists in this repository. Backups stay in their own repository, as [BACKUPS.md](BACKUPS.md) says, and CI needs none.
- `git push` from your clone still runs the pre-push hook.

## Step 8: After going public

1. Search GitHub for your repository's name, and look for forks, a day later and a week later.
2. Watch the first Dependabot, CodeQL and push protection results.
3. Vercel's docs say collaboration is free for public repositories, so its checks on who authored a commit differ from private ones. Confirm that deployments still happen only from `main` and `staging`, and only after review. Check this in the dashboard.
4. Update [Record 1](adr/0001-private-repo-built-to-public-standards.md) with the date and what changed.

## Publish from a new repository

Use this if a scan found anything, if you found text you do not want public, or if you have no permission to use the club's name. Rewriting this repository is not enough, because `refs/pull/*`, cached commit views and forks keep the old commits.

1. If a secret was involved, rotate it first by following [SECURITY.md](../SECURITY.md).
2. Remove every name from the files, including those in Step 1. Change the `name` in `package.json` and the `User-Agent` in `src/discord/client.ts` and `scripts/register-commands.ts`, and update their tests. Merge this in the private repository.
3. Export the files with no Git history, into a new folder outside your clone:

   ```sh
   mkdir ../public-copy
   git archive main | tar -x -C ../public-copy
   cd ../public-copy
   git init -b main
   git config user.name "<github-username>"
   git config user.email "<id>+<github-username>@users.noreply.github.com"
   npm run hooks:install
   git add .
   git commit -m "feat: publish the project"
   ```

   The noreply address and the hook setting are stored per clone, so they did not come across with the files. Set them before committing. Your address is under Settings > Emails on GitHub.

4. Check the identity and scan this folder. `<old-clone>` is the clone you exported from, which holds the gitleaks binary. This folder has none, because `.tools/` is not tracked.

   ```sh
   git log --format='%an %ae %cn %ce'
   ../<old-clone>/.tools/gitleaks dir . --config .gitleaks.toml --redact
   ../<old-clone>/.tools/gitleaks dir . --config .gitleaks-custom.toml --redact
   ```

   **Expect:** one line from `git log`, with your username and noreply address in both places, and no leaks from either scan.

   **If the identity is wrong, or a scan reports an email address under `.git/`:** run `rm -rf .git` here and go back to `git init` in step 3. Do not amend, because the reflog keeps the old address.

   Then run the searches from Step 1 and read the file list. Confirm that `.env`, keys and dumps are absent.

5. Create a new empty repository on GitHub with a name that does not identify the club. Install gitleaks here, which the pre-push hook needs, and push:

   ```sh
   npm run gitleaks:install
   git remote add origin <new-repository-url>
   git push -u origin main
   ```

   **Expect:** a `pre-push: scanning` line, then a normal push. A push refused for exposing your email means the identity is wrong, so use the fix in step 4.

   Then do Steps 4 to 8 on the new repository.

6. Keep the old repository private. Do not delete it until you are sure, because it holds the review history.
7. Vercel can stay on the private repository. If you move it, follow the Vercel part of [HANDOFF.md](HANDOFF.md) for the link, and keep the backups repository as it is.

The published history then starts at one commit. Say so in the README if it helps a reader, and say the review history is kept privately.
