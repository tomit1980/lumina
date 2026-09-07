-- Task collaborators: one owner (tasks.assignee_id) plus a set of
-- collaborators. Mirrors task_attachments (20260906000400_attachments.sql:
-- 67-71, 175-222) — a two-column join table whose policies scope through
-- the parent task's project — rather than project_members, which carries a
-- level column this table deliberately does not want: a collaborator row is
-- a bare fact ("this person is on this task"), with no gradations.
--
-- Every policy below follows the four rules Plan 1's probes established the
-- hard way, each of which was a real hole:
--   1. no `for all` (permissive policies OR together, so a `for all` USING
--      clause silently governs select too);
--   2. WITH CHECK scoped to the specific row, never a global permission;
--   3. policy helper functions are `security definer` with
--      `set search_path = public`, or they recurse or evaluate under the
--      attacker's own visibility;
--   4. every outer column reference inside a policy subquery is
--      table-qualified (`task_collaborators.task_id`) — a bare `task_id`
--      resolves to the subquery's own column and makes the predicate
--      unconditionally true.
-- Column freezes and cross-row rules are triggers, not policies: a policy
-- cannot compare NEW to OLD.

-- ---------------------------------------------------------------------
-- Per-user project visibility.
--
-- The existing can_see_project(proj_id) reads auth.uid() and so can only
-- answer "can *I* see it". The insert trigger below has to ask "can *that
-- person* see it" about a user who is not the caller, so it needs the user
-- passed explicitly.
--
-- SECURITY DEFINER: it reads projects and project_members, both
-- RLS-protected, and is called from policies on task_collaborators — under
-- the caller's own visibility it would either recurse or silently answer
-- from a restricted view of the membership table rather than from the true
-- rows.
--
-- Parameters are referenced as user_can_see_project.<name> throughout: the
-- brief's chosen names (project_id, user_id) collide with real column names
-- on projects/project_members, and an unqualified reference in a SQL-language
-- function is resolved ambiguously. Qualifying by function name is exact.
--
-- Deliberately NOT short-circuited on a null user_id: with auth.uid() null
-- (anonymous), a non-restricted project must still read as visible, which is
-- exactly what can_see_project does today. The remaining branches all
-- compare against a null and so yield false on their own.
--
-- The `created_by` branch is the parity fix required by the ledger's Task 2
-- ruling: lib/store.tsx's canUserSeeProject (line 245) returns true for a
-- restricted project's own creator even when they hold no project_members
-- row, and the SQL side had no such clause. Both sides keep the creator as
-- an editor by invariant (store: ensureEditor(); DB:
-- project_members_ensure_creator, 20260906000500_invariants.sql), so this
-- only bites when a creator is somehow absent from the member list — but
-- there the divergence showed the project in the UI while the API returned
-- zero rows.
create or replace function public.user_can_see_project(project_id text, user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when exists (select 1 from public.profiles pr
                     join public.roles r on r.id = pr.role_id
                    where pr.id = user_can_see_project.user_id
                      and 'members.manage' = any (r.permissions)) then true
      when exists (select 1 from public.projects p
                    where p.id = user_can_see_project.project_id
                      and p.restricted = false) then true
      when exists (select 1 from public.projects p
                    where p.id = user_can_see_project.project_id
                      and p.created_by = user_can_see_project.user_id) then true
      when exists (select 1 from public.project_members m
                    where m.project_id = user_can_see_project.project_id
                      and m.user_id = user_can_see_project.user_id) then true
      else false
    end;
$$;

-- Redefined (not edited in place — 20260906000300_projects.sql is already
-- applied) to delegate to the function above. Delegation rather than a
-- copied creator clause is the point: the two can no longer drift, which is
-- the failure the ledger's ruling is about. Semantics are otherwise
-- unchanged — has_permission('members.manage') is the same lookup the first
-- branch above performs, just for auth.uid() specifically.
create or replace function public.can_see_project(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_can_see_project(proj_id, auth.uid());
$$;

-- ---------------------------------------------------------------------
create table public.task_collaborators (
  task_id text not null references public.tasks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (task_id, user_id)
);

-- The primary key already indexes (task_id, ...) for "who is on this task".
-- This covers the other direction — "which tasks am I on" — which is the
-- read behind the `mine` filter added in Task 3.
create index task_collaborators_user_idx on public.task_collaborators (user_id);

alter table public.task_collaborators enable row level security;

create policy task_collaborators_read on public.task_collaborators
  for select to authenticated
  using (exists (select 1 from public.tasks t
                  where t.id = task_collaborators.task_id
                    and public.can_see_project(t.project_id)));

-- Insert and delete are separate policies with identical bars, and there is
-- deliberately NO update policy at all: a collaborator row carries no
-- mutable payload, so "change who is on this task" is a delete plus an
-- insert, each of which re-runs the checks below and (for insert) the
-- invariant trigger. An update policy would open a path to rewrite task_id
-- or user_id on an existing row while only the pre-image was ever checked.
create policy task_collaborators_insert on public.task_collaborators
  for insert to authenticated
  with check (
    public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_collaborators.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  );

create policy task_collaborators_delete on public.task_collaborators
  for delete to authenticated
  using (
    public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_collaborators.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  );

-- ---------------------------------------------------------------------
-- Invariant A — the DB mirror of the store's two collaborator rules
-- (lib/store.tsx createTask/updateTask): the owner is never also a
-- collaborator, and assignment never grants access — a person who cannot
-- see the project cannot be put on its tasks.
--
-- This must be a trigger, not a policy: the second rule is about a third
-- party's visibility (NEW.user_id), not the caller's, and RLS has no way to
-- express "evaluate this predicate as someone else".
--
-- SECURITY DEFINER: it reads tasks (RLS-protected) to resolve the row's
-- project and owner. Under the caller's own visibility a task they cannot
-- see would read as absent and the guard would misfire.
create or replace function public.check_task_collaborator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project  text;
  v_assignee uuid;
begin
  select t.project_id, t.assignee_id
    into v_project, v_assignee
    from public.tasks t
   where t.id = new.task_id;

  -- Unreachable through the foreign key alone (BEFORE INSERT runs first,
  -- so this raises the honest reason rather than a generic FK violation).
  if v_project is null then
    raise exception 'Task % not found', new.task_id;
  end if;

  if v_assignee is not null and new.user_id = v_assignee then
    raise exception 'The task owner cannot also be a collaborator';
  end if;

  if not public.user_can_see_project(v_project, new.user_id) then
    raise exception 'That person cannot see this task''s project';
  end if;

  return new;
end;
$$;

create trigger task_collaborators_check_insert
  before insert on public.task_collaborators
  for each row execute function public.check_task_collaborator();

-- ---------------------------------------------------------------------
-- Invariant B — promoting a collaborator to owner must not leave them in
-- both roles. Fires on tasks, not task_collaborators, because that is where
-- the change originates; the insert trigger above only guards the other
-- direction (adding a collaborator who is already the owner).
--
-- AFTER, not BEFORE: the side effect is a write to a different table, and
-- nothing about the tasks row itself is being altered.
--
-- No `session_user = 'supabase_auth_admin'` bypass is needed here, unlike
-- the profiles triggers in 20260906000500_invariants.sql: an auth-user
-- deletion cascades as a DELETE on profiles (and from there, through this
-- table's own `on delete cascade`), never as an UPDATE of tasks.assignee_id,
-- so that cascade never reaches this trigger.
create or replace function public.drop_collaborator_on_assign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assignee_id is not null then
    delete from public.task_collaborators
     where task_collaborators.task_id = new.id
       and task_collaborators.user_id = new.assignee_id;
  end if;
  return new;
end;
$$;

create trigger tasks_drop_collaborator_on_assign
  after update of assignee_id on public.tasks
  for each row
  when (new.assignee_id is distinct from old.assignee_id)
  execute function public.drop_collaborator_on_assign();
