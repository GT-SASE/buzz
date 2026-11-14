# 3. Discord-native configuration

Status: Accepted. Implemented: `/setup` and `/config`.

## Context

Channels and scope must be set after launch, not hard-coded, and by the club's admins rather than a developer. A website is the usual way to do this. It would add Discord OAuth login, sessions, CSRF protection, a browser-facing surface and a second thing to host and maintain, all to edit a few settings. Discord already authenticates the user and sends their roles in a signed payload.

## Decision

Configure the bot with a `/config` panel made of Discord components, with no website in v1. The panel covers managed forums, reminders on or off (which doubles as a kill switch), and the last 5 changes. `/setup` separately binds the club's five roles: E-board, Events Directors, Events Committee, Treasury Committee and Marketing Committee. The club has no separate admin role, so `/setup` also saves the E-board role as the admin role. Every other command refuses until it is done.

All configuration writes go through one Postgres function that does the version check and the audit row together, so two open panels cannot overwrite each other. Removing a forum stops all bot posts there, including reminders. Its data is kept, the panel warns with the open-task count, and re-adding the forum resumes. Re-adding also redraws the forum's 10 most recently changed posts, because a change made while it was removed never reached them, and a closed event has no later change to do it.

Turning reminders back on does not reopen a day's run that has already happened, even one that had nothing to send because reminders were off. Reminders resume with the next day's run, and a reminder whose day passed while they were off is not sent late. The panel says so.

## Consequences

- There is no browser client and no login to build or defend, and the panel uses the same signature check and authorization as every other command.
- Discord's components limit the interface: few controls per message, short select lists and no free layout. Settings that do not fit need paging or a modal.
- There is no bulk editing, and the panel shows only the last 5 changes. Anything older needs direct database access.
- The token from opening a panel expires after 15 minutes, so the bot can no longer edit the panel with it. A later click starts a new interaction with its own token and can still update the panel. A change based on an old view is refused by the version check, and the user then has to reopen the panel.
- Configuration can only be changed from Discord, so an outage there blocks changes until it is resolved. If the bound roles are lost, an Administrator can still use `/config` and rebind them with `/setup`.

- The panel sends no default values in its channel select, so a deleted channel cannot stop it being drawn. Managed forums are listed as text and removed through their own select.
- The top-level `app_permissions` in an interaction describes the channel it came from, not a channel chosen in a select, and the bot is granted access per channel, so it is not used. When adding a forum, the bot's permissions come from `resolved.channels[id].app_permissions` if Discord includes it, or else from the guild's roles and that forum's overwrites. If neither is available the panel says it cannot check, and nothing changes.

## Checks against real Discord

These can only be proved against real Discord and Vercel:

- Does a channel select's `resolved.channels[id]` include `app_permissions`, and does it describe that channel? If not, every add relies on the overwrite computation.
- Does `waitUntil` keep the work running after the acknowledgement? It silently does nothing if Vercel's request context is missing, so no local test can show this. Run `/config` on the deployment and confirm the deferred reply fills in.
- How soon can a deferred reply be read? `editEphemeralReply` reads it again after a 404, at about 250, 500 and 1000 ms.
- `/setup` with `@everyone` chosen for each role: confirm that it is refused and that Discord sends what the handler expects for that role.

## When to revisit

Reconsider a website if settings outgrow what components can show, admins need bulk edits or a full audit history, someone without a Discord account needs access, or the bot has to serve several servers with separate administrators. Visual polish alone would not justify it.
