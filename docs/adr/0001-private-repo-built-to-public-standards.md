# 1. Built to public standards, now public

Status: Accepted. Updated on 2026-11-11: the repository is now public. The pre-push hook and CI scan are in place.

## Context

The repository started out private, while the bot was unproven, with the plan to publish it once it had run for a while. Anything committed before then would be published with it, so it was written to public standards from the start. GitHub Free also enforces rulesets and branch protection, and offers push protection, CodeQL and private vulnerability reporting at no cost, only on public repositories.

## Decision

Keep the repository public. Before it was published, it was private, with everything written as if it were already public: no secrets, real Discord IDs or member names in code, fixtures, docs or pull requests, and commit emails using the GitHub noreply address. That rule stays. The local gitleaks pre-push hook and gitleaks in CI, with the default rules plus the project's own, are the main defence. Any CI hit means rotating that secret immediately.

The guide for going public is no longer needed and has been removed. A full-history scan stays part of CI.

## Consequences

- Everything in the repository, its history, its pull requests and its Actions logs can be read and copied by anyone. A missed name or ID cannot be taken back, so review before merging matters as much as the scans.
- The hook can be skipped with `--no-verify` or never installed, and CI only sees a secret after it has reached GitHub. That is why a hit means rotation, not just removal.
- Vulnerability reports go through GitHub's private vulnerability reporting, as [SECURITY.md](../../SECURITY.md) says.
- Rulesets, required checks, push protection and CodeQL are available at no cost, but they are settings on GitHub, not files here, so whether they are on has to be checked in the repository's settings.
