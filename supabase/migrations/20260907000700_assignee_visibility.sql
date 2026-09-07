-- Closes the final-review findings on `feat/task-collaborators`
-- (.superpowers/sdd/2026-09-07-task-collaborators/final-review.md):
--
--   F4 — assignment never grants access was enforced for the collaborator
--        slot (20260907000600_task_collaborators.sql's check_task_collaborator
--        trigger) but NOT for the owner slot: tasks.assignee_id could be set
--        to someone who cannot see the task's project. This migration adds
--        the mirror-image trigger on tasks itself.
--   F2 — revoking a user's project_members row left their task_collaborators
--        rows behind. This migration adds a trigger that prunes them.
--   F3 — nothing stopped tasks.project_id from changing (directly against
--        Postgres; the store's updateTask patch type structurally excludes
--        projectId) and stranding collaborators who cannot see the new
--        project. This migration adds a trigger that prunes them too.
--
-- All three follow 20260906000500_invariants.sql / 20260907000600's
-- established shape: SECURITY DEFINER + `set search_path = public` (each
-- reads RLS-protected tables — tasks, projects, project_members — and must
-- see the true rows regardless of the caller's own visibility), and a
-- trigger rather than a policy wherever the predicate is about a *different*
-- row/table than the one being written.

-- ---------------------------------------------------------------------
-- F4 — mirrors check_task_collaborator (20260907000600), but on tasks
-- itself: a NEW.assignee_id that cannot see NEW.project_id is refused. Runs
-- on INSERT too — a task can be created with an owner already set, and the
-- rule must hold from the first write, not just on later reassignment.
--
-- No `session_user` bypass, unlike block_last_admin_removal
-- (20260906000500_invariants.sql): the only automatic write that could set
-- assignee_id outside the app is the column's own
-- `on delete set null` (20260906000300_projects.sql:56) when the assigned
-- profile is deleted. That action always sets NEW.assignee_id to NULL, which
-- this guard already lets through unconditionally (it only evaluates
-- `user_can_see_project` when assignee_id is not null) — so the auth-cascade
-- path this session's other bypasses exist for never reaches the exception
-- branch here, and adding one would just be dead code.
create or replace function public.check_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assignee_id is not null
     and not public.user_can_see_project(new.project_id, new.assignee_id) then
    raise exception 'That person cannot see this task''s project';
  end if;
  return new;
end;
$$;

create trigger tasks_check_assignee
  before insert or update of assignee_id on public.tasks
  for each row execute function public.check_task_assignee();

-- ---------------------------------------------------------------------
-- F2 — the project_members-delete mirror of the store's setProjectAccess
-- pruning (lib/store.tsx): once a member row is gone, re-derive whether
-- that person can still see the project at all (they might remain visible
-- via members.manage or the creator clause) and, if not, drop their
-- collaborator rows on this project's tasks.
--
-- AFTER, not BEFORE: this must run once the member row is truly gone, since
-- user_can_see_project's own project_members branch needs to see the
-- post-delete state to answer correctly for this user.
--
-- Safe under both cascade directions from a project deletion (tasks and
-- project_members both carry `on delete cascade` from projects): if
-- project_members rows are cascaded first, the `using public.tasks` join
-- below still finds the (not-yet-deleted) tasks and prunes their
-- collaborator rows — redundant with those rows' own cascade a moment
-- later, never wrong. If tasks are cascaded first, the join finds nothing
-- and this is a no-op. Either order, no error, no stale row survives.
create or replace function public.prune_collaborators_on_member_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.user_can_see_project(old.project_id, old.user_id) then
    delete from public.task_collaborators tc
      using public.tasks t
     where tc.task_id = t.id
       and t.project_id = old.project_id
       and tc.user_id = old.user_id;
  end if;
  return old;
end;
$$;

create trigger project_members_prune_collaborators
  after delete on public.project_members
  for each row execute function public.prune_collaborators_on_member_removal();

-- ---------------------------------------------------------------------
-- F3 — re-parenting a task (tasks.project_id) must not strand a
-- collaborator who cannot see the destination project. Structurally
-- impossible through the store today (updateTask's patch type is
-- `Partial<Omit<Task, "id" | "projectId">>`), so this is a Postgres-only
-- gap — exactly what the reviewer's probe (final-review.md, "A1 re-parent")
-- exercised directly against the table.
--
-- AFTER, not BEFORE: the side effect is a write to a different table
-- (task_collaborators), mirroring drop_collaborator_on_assign
-- (20260907000600_task_collaborators.sql) rather than the visibility
-- triggers above, which validate the row being written itself.
create or replace function public.prune_collaborators_on_reparent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.task_collaborators tc
   where tc.task_id = new.id
     and not public.user_can_see_project(new.project_id, tc.user_id);
  return new;
end;
$$;

create trigger tasks_prune_collaborators_on_reparent
  after update of project_id on public.tasks
  for each row
  when (new.project_id is distinct from old.project_id)
  execute function public.prune_collaborators_on_reparent();
