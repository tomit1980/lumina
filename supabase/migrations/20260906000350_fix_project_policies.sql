-- Fixes three RLS gaps found reviewing task 6 (commit df12594), all in
-- policies the brief supplied rather than defects introduced by that
-- task's own implementation. See task-6-report.md's follow-up review.

-- ---------------------------------------------------------------------
-- Finding 1 (fixed first — the deepest): project_is_manageable treats
-- created_by = auth.uid() as an unconditional bypass, and nothing stops
-- an UPDATE from setting created_by to the caller. With the seeded roles
-- this isn't reachable (Member lacks project.create, so projects_update's
-- USING blocks it), but it goes live the moment a custom role holds
-- project.create without members.manage — an ordinary "project manager"
-- role, and createRole already ships in the app. Once created_by is
-- self-assigned, project_is_manageable's creator branch hands that user
-- permanent, unconditional control of the project (and, via
-- project_members_insert/_update/_delete, its membership too).
--
-- A WITH CHECK can't compare NEW against OLD, which is exactly what's
-- needed here, so this is fixed with a BEFORE UPDATE trigger instead of a
-- policy — mirrors block_self_role_change's structure
-- (20260906000100_identity.sql). Applied to both projects and channels:
-- channels has the same shape (created_by = auth.uid() is exactly what
-- channel_is_manageable bypasses on too), and while channels_update's own
-- USING clause happens to block this attack today (it already requires
-- being the creator or holding channel.delete before you can update the
-- row at all), freezing the column here too is defence in depth against
-- that policy ever loosening independently of this one.
--
-- The service role is let through — a single extra clause
-- (auth.role() = 'service_role') — since this codebase's test helpers
-- only ever seed created_by via insert, never reassign it via update, so
-- there is nothing relying on the bypass to keep working.
create or replace function public.freeze_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is distinct from old.created_by
     and auth.role() <> 'service_role' then
    raise exception 'created_by cannot be changed after creation';
  end if;
  return new;
end;
$$;

create trigger projects_freeze_created_by
  before update on public.projects
  for each row execute function public.freeze_created_by();

create trigger channels_freeze_created_by
  before update on public.channels
  for each row execute function public.freeze_created_by();

-- ---------------------------------------------------------------------
-- Finding 2 — CONFIRMED EXPLOITABLE: tasks_update's WITH CHECK tested
-- can_see_project(project_id) on the new value but never
-- project_is_viewer_only(project_id), so a user who could edit a task in
-- one project (say, one they hold task.edit and editor-level access to)
-- could re-parent it into a restricted project where they are only a
-- viewer, planting it there. tasks_insert already enforces both halves
-- for a freshly created task; this brings tasks_update's WITH CHECK into
-- line with it for the destination of a move.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to authenticated
  using (public.has_permission('task.edit')
         and public.can_see_project(project_id)
         and not public.project_is_viewer_only(project_id))
  with check (public.can_see_project(project_id)
              and not public.project_is_viewer_only(project_id));

-- ---------------------------------------------------------------------
-- Finding 3 — projects_delete had no visibility gate at all: `using
-- (has_permission('project.delete'))` alone let any holder of that global
-- permission delete a restricted project they cannot even see, while
-- tasks_delete correctly pairs its permission with can_see_project and
-- the viewer-only exclusion. Brought into line with tasks_delete,
-- including the viewer-only exclusion: level='viewer' on a restricted
-- project denotes a specifically read-only relationship to that project,
-- and (per Finding 1's reasoning) a custom role can hold project.delete
-- without members.manage just as easily as one can hold project.create
-- without it — so a project's own viewer should not be able to delete it
-- out from under its editors merely because their role separately grants
-- a global delete permission. That is exactly the reasoning
-- tasks_delete already applies to a viewer's tasks, so it belongs here
-- too.
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated
  using (public.has_permission('project.delete')
         and public.can_see_project(id)
         and not public.project_is_viewer_only(id));
