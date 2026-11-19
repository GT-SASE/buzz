-- migrate:up

-- A value added to an enum cannot be used in the transaction that adds it, so the new
-- kinds come in a file of their own and the next file puts them to use.

-- Kept in the order the checklist shows the steps.
ALTER TYPE public.event_step_kind ADD VALUE 'engage_picture' AFTER 'engage_post';
ALTER TYPE public.event_step_kind ADD VALUE 'slides' AFTER 'budget_approved';

-- The countdown reminders. daily_steps stays for the rows already logged under it.
ALTER TYPE public.event_reminder_kind ADD VALUE 'steps_unassigned';
ALTER TYPE public.event_reminder_kind ADD VALUE 'budget_due';
ALTER TYPE public.event_reminder_kind ADD VALUE 'engage_due';
ALTER TYPE public.event_reminder_kind ADD VALUE 'budget_overdue';
ALTER TYPE public.event_reminder_kind ADD VALUE 'engage_overdue';
ALTER TYPE public.event_reminder_kind ADD VALUE 'engage_picture_late';
ALTER TYPE public.event_reminder_kind ADD VALUE 'marketing_week';
ALTER TYPE public.event_reminder_kind ADD VALUE 'slides_unassigned';
ALTER TYPE public.event_reminder_kind ADD VALUE 'pickup_unset';
ALTER TYPE public.event_reminder_kind ADD VALUE 'marketing_saturday';
ALTER TYPE public.event_reminder_kind ADD VALUE 'slides_due';
ALTER TYPE public.event_reminder_kind ADD VALUE 'slides_tomorrow';
ALTER TYPE public.event_reminder_kind ADD VALUE 'event_today';

-- migrate:down

-- Not reversible: restore from a backup instead. See docs/RECOVERY.md.
