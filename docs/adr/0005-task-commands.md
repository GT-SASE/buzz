# 5. Task commands

Status: Accepted. Implemented for `/task assign`, `edit`, `delete` and `done`, the Mark done button on task notices and reminders, `/mytasks` and the overview refresh.

## Context

An officer assigns a task, and the bot pings the assignee with its authority behind the text. That makes a task description the most useful place to plant a phishing message, and repeated assignment the easiest way to flood someone. A Mark done button also sits on a message that everyone in the post can see and click.

## Decision

**Quotas.** Triggers enforce both limits when a task is inserted or a reassignment recorded, taking advisory locks so that two writes at once cannot pass a count together. The triggers refuse any isolation level above Read Committed, where a count could miss what the lock made it wait for. The refusal states the number.

| Limit                 | Value | Counts                                                                                                                                   |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks on one event    | 100   | Live tasks, done ones included. This matches the most that a read of an event's tasks returns.                                           |
| Pings from one person | 50    | New tasks and reassignments by one officer in one guild in any 24 hours, deleted tasks included, so that deleting does not free up room. |

A busy event has a few dozen tasks and a busy officer sets up a few at a time, so neither limit should be felt in normal use. To change one, change the migration's triggers and the constants in `src/db/tasks.ts`, which a test holds equal.

**Links.** A plain URL is allowed, because tasks often need one, and is rendered as inert text that nothing can click. A server invite or a masked link is refused: those are the forms that disguise where they go, or bring people somewhere new on the bot's authority. Escaping leaves them inert too, and `SUPPRESS_EMBEDS` stops previews, so the refusal is a second layer.

**Closed events are frozen.** A task on a closed or deleted event cannot be assigned, edited, deleted or marked done, and it leaves `/mytasks` and the pickers. A trigger enforces this for every change of work, reading the event `FOR SHARE` so that a close and a change cannot pass each other. Soft deletes are not caught by it. Nothing is lost, as the rows stay as they were.

**Editing.** All three fields are written at once and the write names the `updated_at` the gate read, so an edit lands whole or is refused. A changed due date restarts the task's reminders because the log is keyed by date, and the reply says so.

**Deleting.** Confirm carries a short fingerprint of the `updated_at` it showed. If the task has changed since, nothing is deleted and the officer is asked to run it again, so nobody deletes text they never saw.

**The button.** It sits on task notices and on reminders, with one per task, and a reminder message holds at most 5 tasks for that reason. A reminder split across messages has its buttons on the last. Anyone can click it, and it answers in a new private reply rather than touching the public message. The router allows this only for a route that asks for it with `onPublicMessage`. Its `custom_id` is a prefix and a task ID: the row is loaded and the clicker checked from that click's payload, and the write repeats the assignee check in its filters.

**One read before the reply.** Discord allows 3 seconds, and the router's read of the guild's config uses the one read there is time for. So a task route uses the `tierOnly` gate, which refuses the wrong tier at once and hands over no row. `finish` then loads the row and calls `authorize` on it, on the client with the longer deadline, and a refusal there is the same fixed text, delivered by editing the private acknowledgement. `createRouter` refuses a `tierOnly` gate on a route that only replies, since that would act with no row checked.

**A failed send keeps the task.** The task is saved before the post is sent. If the send fails, or the event has no post, the officer is told that the person was not mentioned and should be told directly. If Discord gives no clear answer (none at all, a server error or an unreadable success), the message may have gone out, so they are told the person may not have been mentioned and to check the post. A sent notice is reported as a mention, not a ping, because the bot cannot know that anyone was notified.

**A task that won't reach its person is kept, with a warning.** On assign and reassign the bot works out the person's View Channel on the event's forum from its roles and overwrites. Without it they can't open the post, its reminders or its Mark done button, so the officer is warned, and the task still goes through: `/mytasks` shows it, and access may be coming. A forum that is no longer managed works the same way: the task is kept, and the officer is told its reminders are off until the forum is added back. The server owner passes every check in Discord but not this one, so an owner shut out on paper gets a needless warning.

**A stale post is reported, not fatal.** A task change is saved before its overview is redrawn, so a failed redraw only adds a line to the reply. An edit refused because the post is archived unarchives it and tries again. If AutoMod refuses the overview, the line says to edit the task, because finding the one task to blame would take a request per task. A refresh reads the event again after its edit and redraws if the event was closed meanwhile, because nothing redraws a closed event later.

**Typed text.** Discord can submit what was typed instead of a picker choice. A whole short ID finds its row among those the actor could pick, and is then authorized as usual. Other text gets a reply asking for a choice, not the fixed refusal: it matched no row, so that reveals nothing. `/task delete` can also pick done tasks, as they count towards the limit of 100.

## Consequences

- A reassignment is counted before the task changes, so an edit that then fails, as stale or on a closed event, still costs one of the 50. The rows are few and are kept.
- A task update and `soft_delete_event` now lock in one order, the task and then the event, so that pair no longer deadlocks. Two cases remain. A task inserted and updated in the moment its event is being deleted can still deadlock with the delete, which takes three requests inside a few milliseconds. A transaction holding several task writes across events or officers can deadlock with another, though the bot sends one write per request. Postgres cancels one, which rolls back whole and fails safely, and the person gets the failure reply.
- A member's refused click still costs a claim row and two more requests, because the claim comes before the row is read. Claims are small and can be deleted after a day.
- Autocomplete reads the config and then searches, so at worst it takes two 1.5 second requests. A slow one means Discord shows no choices, and nothing else is lost.
- An officer can still ping someone with a plain URL in a task. It can't be clicked and shows its real address, but it can be copied. Only a person can judge such text.
- Unconfirmed, to check on staging: that escaped URLs are not clickable on desktop and mobile, and how they copy.
- `/mytasks` lists up to 100 tasks and shows as many as fit one message, then says how many more there are. Past 100 it says "at least", because the count stops at the rows read.
- Picker text that could be the start of an ID costs one more indexed read, in parallel with the search.
- Quota numbers are per guild and per officer, so someone holding several officer accounts gets each account's allowance. The per-event limit still applies to them all.
