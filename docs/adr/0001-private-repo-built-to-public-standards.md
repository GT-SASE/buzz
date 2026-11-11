# 1. Private repository, built to public standards

Status: Accepted. The repository is private, and the pre-push hook and CI scan are in place. `docs/PUBLIC_RELEASE.md` has the steps for going public.

## Context

The bot is unproven, and the club has not yet agreed to be named in a public project. The repository may still be worth publishing once the bot has run for a while, and anything committed now would be published with it. GitHub Free does not enforce rulesets or branch protection on private repositories. Push protection and CodeQL are also generally unavailable there at no cost, and private vulnerability reporting is documented only for public repositories.

## Decision

Keep the repository private, and consider going public after about a month of working production use. Until then, write everything as if it were already public: no secrets, real Discord IDs or member names in code, fixtures, docs or pull requests, and commit emails use the GitHub noreply address. The local gitleaks pre-push hook and gitleaks in CI are the main defence. Any CI hit means rotating that secret immediately.

Before going public:

1. Scan the full Git history, including every `refs/pull/*` ref fetched from GitHub, and read PR text, reviews and Actions logs, which become public too. Rewritten commits may stay reachable on GitHub, so if a secret or real name turns up, publish from a new repository instead of rewriting this one.
2. Check for real IDs and names, including the repository name, README title and package metadata, and get the club's OK to be named. Without that OK, rename the project and publish from a new repository, because the name stays in past commits.
3. Add the MIT licence.
4. Enable the ruleset, push protection, CodeQL and private vulnerability reporting.
5. Restrict PR creation to collaborators, and check that Dependabot still works.

## Consequences

- Nothing stops a direct push to `main` or a merge with failing CI. Pull requests and required checks are conventions until the repository goes public or moves to a paid plan, which this record does not assume.
- The hook can be skipped with `--no-verify` or never installed, and CI only sees a secret after it has reached GitHub. That is why a hit means rotation, not just removal.
- Going public is one-way. A missed name or ID can be copied the moment it is visible, so the full-history review cannot be skipped.
- Until then there is no licence and there are no outside contributors, and vulnerability reports go directly to the owner.
- Actions usage on a private repository counts against the Free quota, so CI has to stay small.
