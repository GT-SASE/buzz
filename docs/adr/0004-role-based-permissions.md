# 4. Role-based permissions

Status: Accepted. Implemented for `/ping`, `/setup`, `/config`, `/event`, `/task` and `/mytasks`.

## Context

Members should see and change only their own tasks, while officers run events. Role holders change over time, and the bot has no gateway connection to watch them. Discord includes the invoking member's roles and permissions in each signed interaction payload.

## Decision

Use these tiers, read from the signed payload on every request and never cached:

| Tier     | Who                                       | Can                                                                                                    |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Public   | Any member                                | `/ping`, which reveals nothing, changes nothing, and works before setup so a deployment can be checked |
| Self     | Any member                                | `/mytasks`, mark own task done                                                                         |
| Officer  | `officer_role_id`, or anyone who is Admin | Create, link, close and delete events, view status, assign, edit and delete tasks, mark any task done  |
| Admin    | `admin_role_id` or Administrator          | Everything Officer can, plus `/config`: managed forums, reminders on or off                            |
| Bindings | Administrator only                        | `/setup`: choose the two roles                                                                         |

Admin stacks on Officer because a Discord Administrator can grant themselves any role anyway, so refusing them would add no security. Bindings does not stack: `admin_role_id` does not reach it. Officers can close and delete events and edit and delete tasks because deletes are soft and recoverable. A role bound to the guild's own ID, which is the `@everyone` role, never counts.

Deny by default. A `COMMAND_POLICY` table maps each action to a tier, each action also declares what row it needs, and a test fails on any unmapped action. Any request other than a PING with no `member` is denied. The caller loads the row by ID and signed guild, then calls `authorize(action, actor, config, resource?)`, which checks the row's guild, its assignee or officer status, and that it is not deleted. An action on a row cannot leave it out, by type. Autocomplete goes through `autocompleteScope`, which applies the same tier and returns the guild and, where the actor is limited to their own rows, the assignee for the query to use. `custom_id` and autocomplete values are never trusted.

`src/handlers/router.ts` applies this to every interaction. Routes are found by exact match in a `Map`, and each is built with a gate that runs `authorize` or `autocompleteScope`, or for a route with no time to read its row first, the tier check alone, with `authorize` called on the row once the reply has gone. A `custom_id` is a prefix and validated IDs or a version, so it can name a row but grant nothing. An unknown or refused interaction gets one fixed private reply. A state-changing route calls `claim_interaction` once before it runs, so a replay changes nothing.

`/setup` rejects `@everyone` and managed roles, lists the roles that may be able to grant the chosen role, and requires a Confirm click. That list is every role with Manage Roles or Administrator, whatever its position, and it is never worded as complete.

## Consequences

- Removing a role takes effect on that member's next interaction, including clicks on a panel that is already open. No role membership is stored, so none can go stale.
- **Residual risk: Discord Administrators can give themselves every tier,** and the bot cannot prevent this. The Bindings tier deliberately trusts them.
- **Residual risk: anyone who can manage roles can grant themselves or others a bound role** that sits below their highest role. `/setup` shows this at binding time, but later changes to the server are not re-checked.
- The bot gets no event when a role is granted, and this design does not poll Discord's audit log. That log is the only record of grants and keeps entries for 45 days, so the club has to keep these two groups small.
- Tiers cover the bot's own actions only. Who can read a forum is decided by Discord's channel permissions, so `/config` warns if `@everyone` can see a managed forum.
- What the server owner's payload contains is unconfirmed and must be tested on staging before launch, since the owner could otherwise be wrongly refused the Bindings tier.
- `member.permissions` is channel-level per Discord's docs, because it includes the channel's overwrites. Whether it can show the Administrator bit from a channel overwrite for a member who is not an administrator is unconfirmed and must be tested on staging before launch, since that member would otherwise hold the Bindings tier.
