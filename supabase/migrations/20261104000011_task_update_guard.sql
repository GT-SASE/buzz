-- A task on a closed or deleted event no longer changes, which the bot's filters cannot
-- enforce because they only see the task's own row. This runs the insert guard on updates
-- too. It reads the event FOR SHARE, so a close waits for a task change in progress, and a
-- task change waiting on a close then sees it and is refused with CF410.
--
-- Only the columns of real work are listed. Soft deletes set deleted_at alone, so deleting
-- a task or an event is never refused.
CREATE TRIGGER tasks_require_open_parent_on_update
  BEFORE UPDATE OF assignee_id, description, due_date, status ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.require_open_parent();
