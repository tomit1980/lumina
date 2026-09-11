-- Task sets: reusable definitions a project can be created from.
--
-- The workspace runs repeatable client work - a Pension Release case per
-- client, each a project, each needing the same twelve tasks. Those tasks are
-- retyped every time. A task set is the definition; creating a project from
-- one instantiates its items as real tasks.
--
-- A SET IS NOT A PROJECT, and the whole design turns on that. Instantiated
-- tasks are ordinary tasks with fresh ids: editing one changes no definition,
-- and editing a definition reaches into no project already created. There is
-- no synchronisation in either direction and none is implied.
--
-- WHAT THE ITEMS DELIBERATELY DO NOT CARRY, in this first version:
--
--   * status - instantiated tasks land in the first open column, which is
--     where a fresh case belongs anyway. Carrying one would mean a foreign key
--     to `statuses`, and therefore a fourth refusal in `deleteStatus` so that
--     removing a board column still explains itself instead of surfacing a raw
--     Postgres error from a table the person has never heard of.
--   * a due-date offset - `Task.dueDate` is epoch milliseconds at *local*
--     midnight, and Postgres does not know the browser's timezone. Computing
--     it here would be computing it wrong.
--   * an assignee - a definition naming a person rots when that person leaves,
--     and an instantiated assignee must satisfy `check_task_assignee`, so the
--     refusal would arrive at instantiation for a reason the person picking
--     the set cannot see.
--
-- All three are additive columns later. None of them is load-bearing for the
-- thing this exists to do.

-- =====================================================================
-- 1. The tables
-- =====================================================================

create table if not exists public.task_sets (
  id          text primary key,
  name        text not null,
  description text not null default '',
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Archive rather than delete. Reversible, and it keeps
  -- projects.created_from_task_set_id pointing at something real.
  archived_at timestamptz
);

-- `task_set_items`, not `task_set_tasks`: they are not tasks, they do not
-- appear on a board, and a name that says "tasks" invites code that treats
-- them as interchangeable with the real thing.
create table if not exists public.task_set_items (
  id          text primary key,
  task_set_id text not null references public.task_sets(id) on delete cascade,
  title       text not null,
  description text not null default '',
  priority    text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  labels      text[] not null default '{}',
  position    integer not null default 0
);

create index if not exists task_set_items_set_idx
  on public.task_set_items (task_set_id, position);

-- Provenance, at the project level only: "which set produced this project" is
-- the question worth answering later. Per-task provenance would put two dead
-- columns on the busiest table in the schema for every task not created this
-- way.
alter table public.projects
  add column if not exists created_from_task_set_id text
    references public.task_sets(id) on delete set null;

-- =====================================================================
-- 2. updated_at, maintained by the database
-- =====================================================================

-- The Settings list shows "last updated". If only `task_sets` updates bumped
-- it, that line would go stale the moment somebody reordered or renamed an
-- item - a screen asserting something it does not know, which is the failure
-- this codebase keeps finding. So an item write touches its parent.
create or replace function public.touch_task_set()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'task_sets' then
    new.updated_at = now();
    return new;
  end if;
  -- An item write: bump the parent instead. On DELETE the parent id is on OLD.
  update public.task_sets
     set updated_at = now()
   where id = coalesce(new.task_set_id, old.task_set_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists task_sets_touch on public.task_sets;
create trigger task_sets_touch
  before update on public.task_sets
  for each row execute function public.touch_task_set();

drop trigger if exists task_set_items_touch on public.task_set_items;
create trigger task_set_items_touch
  after insert or update or delete on public.task_set_items
  for each row execute function public.touch_task_set();

-- =====================================================================
-- 3. The permission, and who holds it
-- =====================================================================

-- `workspace.taskSets` rather than reusing `project.create`.
--
-- 20260906000350_fix_project_policies.sql contemplates a custom role holding
-- `project.create` without `members.manage` - "an ordinary project manager".
-- If managing sets rode on that permission, granting somebody the right to
-- create projects would silently also grant the right to delete the definition
-- every future project is built from. Those are different blast radii, and the
-- second one would be invisible at the moment of granting.
--
-- Both target rows are `locked`. block_locked_role_update's carve-out is
-- `auth.uid() is null or auth.role() = 'service_role'` - widened by
-- 20260910006000_owner_role.sql for exactly this, because a migration runs as
-- postgres with no auth context. enforce_role_rank returns early on a null
-- auth.uid() for the same reason.
update public.roles
   set permissions = array_append(permissions, 'workspace.taskSets')
 where id in ('owner', 'admin')
   and not ('workspace.taskSets' = any (permissions));

-- =====================================================================
-- 4. Row-level security
-- =====================================================================

alter table public.task_sets enable row level security;
alter table public.task_set_items enable row level security;

-- Read: everyone, as with statuses_read. The project dialog's picker needs it,
-- and a set's name is no more sensitive than a board column's.
drop policy if exists task_sets_read on public.task_sets;
create policy task_sets_read on public.task_sets
  for select to authenticated using (true);

drop policy if exists task_set_items_read on public.task_set_items;
create policy task_set_items_read on public.task_set_items
  for select to authenticated using (true);

drop policy if exists task_sets_write on public.task_sets;
create policy task_sets_write on public.task_sets
  for all to authenticated
  using (public.has_permission('workspace.taskSets'))
  with check (public.has_permission('workspace.taskSets'));

drop policy if exists task_set_items_write on public.task_set_items;
create policy task_set_items_write on public.task_set_items
  for all to authenticated
  using (public.has_permission('workspace.taskSets'))
  with check (public.has_permission('workspace.taskSets'));

-- The restrictive assurance policy, added by name. 20260910004000 keeps its
-- table list explicit so that a table added later "should have to be
-- considered, not silently swept in or silently missed" - this is that
-- consideration.
drop policy if exists require_assurance on public.task_sets;
create policy require_assurance on public.task_sets as restrictive to authenticated
  using (public.session_is_assured()) with check (public.session_is_assured());

drop policy if exists require_assurance on public.task_set_items;
create policy require_assurance on public.task_set_items as restrictive to authenticated
  using (public.session_is_assured()) with check (public.session_is_assured());

-- =====================================================================
-- 5. Creating a project and its tasks, atomically
-- =====================================================================

-- A project plus twelve tasks must be all or nothing. supabase-js has no
-- client transaction, so this is a function: one call, one transaction, and a
-- raise rolls back everything it did.
--
-- `security invoker` on purpose. The inserts go through `projects_insert` and
-- `tasks_insert` as the caller, so this function grants nothing - it only
-- bundles. A definer function here would be a permission bypass wearing a
-- convenience costume.
--
-- IDEMPOTENT BY CONSTRUCTION. Ids are generated in the browser, so a retry, a
-- double-click that slips past useSubmitOnce, or a replayed request carries
-- the same ids and `on conflict do nothing` makes it a no-op. There is no
-- idempotency token because there is nothing for one to do.
--
-- AND THEN IT CHECKS. `on conflict do nothing` reports the same zero rows for
-- "already there" as for "RLS filtered it", and a filtered insert raises no
-- error at all - the false-success class `requireRows` exists for. So the
-- verification below asks whether the rows are *there*, which is true after a
-- legitimate retry and false after a refusal.
--
-- Both checks read through RLS themselves, so the failure mode is rolling back
-- work that succeeded but is invisible to the caller: a false negative, never
-- a false positive. That is the safe direction for a function whose job is to
-- refuse partial creation.
create or replace function public.create_project_with_tasks(
  p_project jsonb,
  p_tasks   jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project_id text := p_project ->> 'id';
  v_expected   integer := jsonb_array_length(coalesce(p_tasks, '[]'::jsonb));
  v_landed     integer;
begin
  if v_project_id is null or v_project_id = '' then
    raise exception 'A project id is required.';
  end if;

  insert into public.projects (
    id, name, description, emoji, color, priority, restricted,
    created_by, created_at, created_from_task_set_id
  )
  select
    p_project ->> 'id',
    p_project ->> 'name',
    coalesce(p_project ->> 'description', ''),
    coalesce(p_project ->> 'emoji', '📁'),
    coalesce(p_project ->> 'color', '#7c3aed'),
    coalesce(p_project ->> 'priority', 'medium'),
    coalesce((p_project ->> 'restricted')::boolean, false),
    auth.uid(),
    coalesce((p_project ->> 'created_at')::timestamptz, now()),
    p_project ->> 'created_from_task_set_id'
  on conflict (id) do nothing;

  if not exists (select 1 from public.projects p where p.id = v_project_id) then
    raise exception 'You do not have permission to create projects.';
  end if;

  if v_expected > 0 then
    -- `position` is sent explicitly and non-negative, so set_task_position's
    -- -1 sentinel never fires and the definition's order survives exactly.
    insert into public.tasks (
      id, project_id, title, description, status, priority,
      labels, position, created_by, created_at
    )
    select
      t.id, v_project_id, t.title, coalesce(t.description, ''),
      t.status, coalesce(t.priority, 'medium'),
      coalesce(t.labels, '{}'), t.position,
      auth.uid(), coalesce(t.created_at, now())
    from jsonb_to_recordset(p_tasks) as t(
      id text, title text, description text, status text,
      priority text, labels text[], position integer, created_at timestamptz
    )
    on conflict (id) do nothing;

    select count(*) into v_landed
      from public.tasks tk
     where tk.project_id = v_project_id
       and tk.id in (select x ->> 'id' from jsonb_array_elements(p_tasks) as x);

    if v_landed <> v_expected then
      raise exception
        'The project was not created: % of % tasks were refused.',
        v_expected - v_landed, v_expected;
    end if;
  end if;
end;
$$;

revoke all on function public.create_project_with_tasks(jsonb, jsonb) from public;
grant execute on function public.create_project_with_tasks(jsonb, jsonb) to authenticated;

-- =====================================================================
-- 6. Live updates
-- =====================================================================

-- Without these, a set one person creates does not appear in the other's
-- project dialog until they reload. toRealtimeEvent maps any unrecognised
-- table to `stale`, which the store coalesces into one hydrate - so being in
-- the publication is the entire change.
alter publication supabase_realtime add table public.task_sets;
alter publication supabase_realtime add table public.task_set_items;

alter table public.task_sets replica identity full;
alter table public.task_set_items replica identity full;
