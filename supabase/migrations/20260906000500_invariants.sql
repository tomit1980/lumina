-- Four business invariants ported from lib/store.tsx into the database, so
-- they hold no matter what talks to Postgres directly (RLS alone cannot
-- express any of these — they are cross-row or cross-table rules, not
-- per-row visibility checks).

-- ---------------------------------------------------------------------
-- Invariant 1 — a role with members cannot be deleted (lib/store.tsx:546),
-- and a built-in (is_system) role can never be deleted regardless of
-- membership. Note profiles.role_id already carries
-- `references public.roles (id) on delete restrict`
-- (20260906000100_identity.sql), so the FK alone already stops the
-- members-case at the storage layer; this trigger fires first (BEFORE
-- DELETE beats the FK's own check) purely to give the real reason
-- ("Role still has members") instead of a generic foreign-key-violation,
-- and it is the only thing that stops deleting an empty built-in role
-- (guest/member/admin), which the FK has no opinion on at all.
-- SECURITY DEFINER: must see every profile regardless of the caller's own
-- row-level visibility — profiles_read happens to allow every signed-in
-- user to read the whole directory today, but this invariant must hold
-- even if that policy ever narrows.
create or replace function public.block_role_delete_with_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles where role_id = old.id) then
    raise exception 'Role "%" still has members', old.name;
  end if;
  if old.is_system then
    raise exception 'Built-in roles cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger roles_block_delete_with_members
  before delete on public.roles
  for each row execute function public.block_role_delete_with_members();

-- ---------------------------------------------------------------------
-- Invariant 2 — the last admin cannot be demoted or removed
-- (lib/store.tsx:428-434). Fires on both UPDATE (role_id changed away from
-- 'admin') and DELETE of a profiles row, and — with one narrow exception,
-- below — applies unconditionally, including to the service-role key:
-- nothing may reassign the sole admin's role away from 'admin' via a
-- direct write, matching tests/rls/invariants.test.ts's
-- "refuses to demote the last admin", which exercises exactly that with
-- the service-role client.
--
-- The exception: profiles.id references auth.users(id) on delete cascade,
-- so removing an auth user through Supabase's admin API — what
-- tests/helpers/supabase.ts's deleteTestUser and every probe's cleanup in
-- this repo use, none of which may be modified (task-8-brief.md) —
-- cascades into a DELETE on this row. That cascade runs under Supabase
-- Auth's own dedicated Postgres login role, not PostgREST, so
-- auth.role() is null there and current_user is this function's owner
-- (SECURITY DEFINER), not the caller — session_user is the one signal
-- that still identifies it. This was confirmed empirically, not assumed:
-- instrumenting this trigger during development showed
-- session_user = 'supabase_auth_admin' / current_user = 'postgres' /
-- auth.role() = null for that cascade, and — before this exception
-- existed — a real repo test (attachments.test.ts's "climber", a
-- solo admin at cleanup time) was left stranded by exactly this path,
-- confirming the failure mode is real, not hypothetical. The exception is
-- scoped to DELETE only (GoTru never issues an UPDATE against
-- role_id) and does not weaken the UPDATE branch or any direct,
-- PostgREST-routed DELETE at all — the real in-app "remove member" path,
-- which always runs as 'anon'/'authenticated'/'service_role' with a
-- normal session_user, still hits the full check below unchanged.
--
-- profiles already carries profiles_block_self_role_change
-- (20260906000100_identity.sql) — that trigger and this one coexist on
-- the same table/event; each only ever raises on its own condition
-- (self-change vs. last-admin), so their relative firing order never
-- matters.
create or replace function public.block_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count integer;
begin
  if tg_op = 'DELETE' and session_user = 'supabase_auth_admin' then
    return old;
  end if;

  if tg_op = 'UPDATE' and new.role_id = 'admin' then
    return new;
  end if;
  if old.role_id <> 'admin' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select count(*) into admin_count from public.profiles where role_id = 'admin';
  if admin_count <= 1 then
    raise exception 'The last admin cannot be demoted or removed';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger profiles_block_last_admin
  before update or delete on public.profiles
  for each row execute function public.block_last_admin_removal();

-- ---------------------------------------------------------------------
-- Invariant 3 — a creator is always kept as an editor (ensureEditor,
-- lib/store.tsx:228-233): the creator of a channel/project can never be
-- removed from its own member list while that channel/project exists.
--
-- Must not make the channel/project itself undeletable: deleting the
-- parent cascades to channel_members/project_members (on delete cascade,
-- 20260906000200/300), which fires this same BEFORE DELETE trigger for
-- the creator's own membership row. By the time that cascade reaches
-- here the parent row is already gone (an AFTER-trigger cascade one level
-- up, in the same transaction), so the `select ... into creator` below
-- returns no row, `creator` is null, and the guard does not fire — the
-- delete proceeds. Verified directly in tests/rls/invariants.test.ts
-- ("deleting a channel/project cascades to its members even though the
-- creator never left").
create or replace function public.ensure_channel_creator_editor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  creator uuid;
begin
  select created_by into creator from public.channels where id = old.channel_id;
  if creator is not null and old.user_id = creator then
    raise exception 'The channel creator cannot be removed from its members';
  end if;
  return old;
end;
$$;

create trigger channel_members_ensure_creator
  before delete on public.channel_members
  for each row execute function public.ensure_channel_creator_editor();

create or replace function public.ensure_project_creator_editor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  creator uuid;
begin
  select created_by into creator from public.projects where id = old.project_id;
  if creator is not null and old.user_id = creator then
    raise exception 'The project creator cannot be removed from its members';
  end if;
  return old;
end;
$$;

create trigger project_members_ensure_creator
  before delete on public.project_members
  for each row execute function public.ensure_project_creator_editor();

-- ---------------------------------------------------------------------
-- Invariant 4 — moving a task renumbers its whole destination column
-- atomically (moveTask, lib/store.tsx:977-1010).
--
-- SECURITY INVOKER (not DEFINER): this is an RPC a client calls directly,
-- not a trigger, and it must run under the caller's own RLS so a user who
-- cannot see a project cannot move a task in it — the initial select
-- below is exactly what enforces that (tasks_read requires
-- can_see_project(project_id); if RLS hides the row, v_project stays
-- null and the function raises rather than silently updating nothing).
-- The subsequent UPDATE statements are likewise subject to tasks_update,
-- which requires has_permission('task.edit') (20260906000300_projects.sql
-- / 20260906000350_fix_project_policies.sql).
--
-- That is one permission short of the app's own gate: lib/store.tsx's
-- moveTask checks task.move, not task.edit. Left as-is deliberately:
-- tasks_update is an existing, shared policy (not owned by this
-- migration) that every task mutation already goes through, and RLS has
-- no column-level concept — loosening it to accept task.move as an
-- alternative would let any task.move-only role rewrite a task's title,
-- description, or assignee too (tasks_update's WITH CHECK covers the
-- whole row), which is a strictly bigger grant than "may reorder the
-- board" and not something this migration is scoped to introduce. Every
-- seeded role that holds task.move (Member; Admin holds everything)
-- already holds task.edit too, so nothing observable changes today for
-- any role this schema actually ships. See task-8-report.md for the full
-- writeup and the seeded-role check that confirms this.
create or replace function public.move_task(
  p_task_id text,
  p_status  text,
  p_index   integer
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project text;
  v_from    text;
begin
  select project_id, status into v_project, v_from
    from public.tasks where id = p_task_id;
  if v_project is null then
    raise exception 'Task % not found or not visible', p_task_id;
  end if;

  update public.tasks set status = p_status where id = p_task_id;

  -- Renumber the destination column, opening a slot at p_index for the moved task.
  -- Integer arithmetic throughout: assigning a fraction to an integer column would
  -- be rounded by Postgres and silently lose the intended position.
  with others as (
    select id, row_number() over (order by position, created_at) - 1 as rn
      from public.tasks
     where project_id = v_project and status = p_status and id <> p_task_id
  ),
  final as (
    select id, case when rn < p_index then rn else rn + 1 end as new_pos from others
    union all
    select p_task_id, least(greatest(p_index, 0), (select count(*)::int from others))
  )
  update public.tasks t
     set position = final.new_pos
    from final
   where t.id = final.id;

  -- Close the gap the task left behind in its old column.
  if v_from is distinct from p_status then
    with ordered as (
      select id, row_number() over (order by position, created_at) - 1 as new_pos
        from public.tasks
       where project_id = v_project and status = v_from
    )
    update public.tasks t
       set position = ordered.new_pos
      from ordered
     where t.id = ordered.id;
  end if;
end;
$$;
