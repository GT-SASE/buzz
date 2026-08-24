## What this changes

<!-- One or two sentences. What a future officer needs to know, not a diff summary. -->

## Why

<!-- The problem or request behind it. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm check` passes locally (lint, typecheck, format, tests)
- [ ] Schema changes went through `pnpm db:generate` and the SQL under `packages/db/drizzle/` is committed
- [ ] No secret, member email, or check-in code appears in the diff, a log line, or a screenshot
- [ ] Member-facing queries still exclude `checkInCode` — it is a bearer credential
- [ ] New or changed behaviour has a test

## How it was verified

<!-- What you actually ran or clicked. "CI is green" on its own is not a test plan
     for anything touching check-in, points, or the roster. -->
