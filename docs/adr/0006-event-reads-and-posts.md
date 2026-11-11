# 6. Event reads and what happens to a post

Status: Accepted. Implemented: `/event`.

## Context

The bot can see every forum it manages, and an officer may not be able to see all of them. `/event status` and `/event list` therefore answer with things the invoking officer could not read in Discord. `member.permissions` in a payload covers only the channel the command ran in, so working out what an officer can see in each forum would take the guild's roles and every forum's overwrites on each read.

Events also outlive their state in the bot. A closed or deleted event still has a post, and the bot is deliberately not granted Manage Threads, so it cannot archive, lock or delete one.

## Decision

**Reads.** Officers see every event in the guild through the private commands, whichever managed forum it belongs to and whether or not they can see that forum in Discord. This includes events in a forum that has since been removed, shown with a note. The officer tier is the boundary, and replies are ephemeral. `/config` warns when `@everyone` can see a managed forum, so a sensitive forum's privacy is the admins' choice of who holds the officer role. An officer who can't see a managed forum can still make the bot post there, because the officer tier is the boundary.

**Close.** The event's status changes and its reminders stop. The post stays, gets one line saying who closed the event, and the overview is updated to show it as closed. An event with no post yet cannot be closed: finish creating it or delete it. There is no Confirm and no reopen command, so the reply says that the bot's maintainer can reopen an event by hand.

**Delete.** A Confirm button is required, and it is authorized again from its own payload. It carries a fingerprint of the event and its tasks as shown, so a click after either has changed deletes nothing and says why. That check is a read just before the delete, so a task added in that instant is still deleted. `soft_delete_event` removes the event and its tasks from every read, and reminders stop. The post stays, with one line saying who deleted the event, and the bot stops tracking it. Its overview is left as it was. The post can then be linked to a new event.

**Timing.** These commands check the tier, then acknowledge, then load the event, as the task commands do. That keeps to one read before Discord's 3 seconds run out. A wrong tier is refused at once, and a row the officer may not use gets the same words after the acknowledgement. An officer who names no event, outside an event's post, is told to choose one.

**Failure.** The change to the event has already happened by the time a post is told, so a failed line or overview edit is reported in the private reply and never undoes the change. Closed events take no other change that would redraw the overview, so running `/event close` again redraws it. It does not send the line again. In a removed forum the line is not sent at all: removing a forum stops all bot posts there, and close and delete still work.

**A deleted post.** The next send or overview edit marks the event `missing` and its reminders stop. Its tasks cannot move to another event, so a second event would strand them. `/event create` with the same name and date in the same forum therefore gives the same row a new post, and `/event link` adopts a row with the post's title and that date, for someone else's post as well. For a replacement post with another title, `/event link` takes the event from its event option, and then needs no date. The stored name stays as it was, so this is the one case where a name and its post's title differ. The post must be in the event's forum. Tasks and reminders carry on, and a new overview shows the tasks. A closed event is not taken up. If two events match, none is chosen.

**Post names.** A name is normalised, not refused, when anything usable remains, so `@everyone party` becomes `everyone party`. The stored name and the post's title are the same text. Linking a post applies the same rule to its title, without renaming the post, because the bot cannot.

## Consequences

- An officer learns the names, dates and assignees of events in forums hidden from them. Holding the officer role is treated as being trusted with this.
- Unarchiving a post to edit its overview needs no Manage Threads by Discord's docs, only Send Messages, unless the post is also locked. A locked post stays stale, and the officer is told.
- A deleted event's overview stays visible and goes stale. The line beneath it says why, and members with access to the forum can still read it.
- Close and delete can run from anywhere with the event picker, so the reply is the place a person learns that the post could not be told.
- A second event with the same name and date in the same forum is refused while the first has a post, whether by `/event create` or `/event link`. This is checked by a read, so two new events at the same moment can both succeed, leaving two recorded posts that can each be deleted.
- Two retries of one pending event cannot both post. The first takes a post attempt on the row, the other is told it is in progress, and the attempt lapses after 60 seconds so a crash cannot leave the event stuck. A clear refusal from Discord gives it back at once. After an unclear failure the post may exist, so a retry waits out the minute and then looks for it first.
- A post found this way must be the bot's own, in the event's forum, with its title, made since the row and named by no event, including a deleted one, whose post stays in the forum. Only `/event link` takes up a deleted event's post. If more than one fits, none is adopted and no post is made. A retry can't settle that, so the reply names the posts and a person decides, using `/event link` inside the right one with the event option.
- Lists are capped, so they put active events and open tasks first. A hundred finished rows cannot hide a live one. A name search uses an index only to find the guild: `%term%` cannot use one for the name.
- Lookalike names are told apart by date and short ID in pickers. There is no check for confusable names at creation.

- `/event link` can still leave two overviews in a post, and this is accepted. If its overview's ID can't be saved after five tries over a couple of seconds, or 22 seconds if the database hangs, the reply says so and the log holds both IDs, and the next change posts a new overview. The same happens if a send lands and its answer is lost. Looking for the old one would take Read Message History, which the bot is not granted, and a spare overview is untidy rather than wrong.
- Replacing a deleted post has no post attempt to take, because that mark only covers pending rows. Two replacements at the same moment can each make a post. One is joined to the event, and the other's reply names the spare post so that a moderator can remove it.
- A deleted post is only noticed at the next send or overview edit. Until then `/event create` and `/event link` still point at the old post.

## Checks on staging

- A forum that requires tags refuses a post from the bot, which sets none. The reply should say so, which relies on Discord's code 40067 and on it arriving before any post exists.
- Reading a forum's archived threads needs Read Message History by Discord's docs, and the bot's planned permissions are View Channel, Send Messages and Send Messages in Threads. A refusal is treated as no archived posts, so a lost post that has since been archived is not found. Confirm the refusal, and decide whether the permission is worth adding.
- Whether a post's first message shares its ID, and whether `owner_id` on the bot's posts equals the application ID. Adoption relies on both.
- Which of AutoMod's codes a blocked post gets: 200000 for its text, 200001 for its title, 240000 for a harmful link. Also 40066 for a forum whose tags only moderators can set, and 160006 at the limit on active posts.
- That sending to or editing in a deleted post answers 404 with code 10003, which is what marks the event `missing`, and that editing an old overview's ID in a replacement post answers 10008.

## When to revisit

Compute per-forum access if a club wants forums that some officers must not read about through the bot. Grant Manage Threads and archive closed posts if members find open posts for finished events confusing.
