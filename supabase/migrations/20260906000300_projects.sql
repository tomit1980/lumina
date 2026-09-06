-- Projects, project membership, and tasks. Written directly against the
-- two known defects in the task-6 brief rather than shipping them and
-- patching afterward (as task 5's conversations migration had to be):
--
--   Defect 1: the brief's project_members_write was `for all` with a
--   with check testing only has_permission('project.create') — a global
--   permission, not the specific project. `for all` combines (OR) with
--   the neighbouring project_members_read policy (Postgres ORs multiple
--   permissive policies together), so its using clause silently grants
--   select too, letting anyone holding project.create enumerate a
--   restricted project's membership without being able to see the
--   project itself. And its with check let a user insert *themselves*
--   into a restricted project's member list, which can_see_project()
--   then trusts, handing them the project and all its tasks. Fixed by
--   splitting into insert/update/delete (select stays governed solely by
--   project_members_read) and scoping every check to the specific
--   project via project_is_manageable, mirroring the app's own rule for
--   managing a project's access: has_permission('project.create') AND
--   able to see the project AND not viewer-only, OR members.manage
--   always bypasses, OR the project's own creator can always act on it
--   (this last branch also preserves the bootstrap case: the creator of
--   a brand-new restricted project can add themselves as its first
--   member even before any project_members row exists for them).
--
--   Defect 2: the brief's projects_insert never bound created_by, so a
--   project could be created attributed to someone else — which would
--   also undermine project_is_manageable's creator bypass above. Fixed
--   by requiring created_by = auth.uid() in the with check.
create table public.projects (
  id          text primary key,
  name        text not null,
  description text not null default '',
  emoji       text not null default '📁',
  color       text not null default '#7c3aed',
  priority    text not null default 'medium' check (priority in ('high','medium','low')),
  restricted  boolean not null default false,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.project_members (
  project_id text not null references public.projects (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  level      text not null default 'editor' check (level in ('viewer','editor')),
  primary key (project_id, user_id)
);

create table public.tasks (
  id               text primary key,
  project_id       text not null references public.projects (id) on delete cascade,
  title            text not null,
  description      text not null default '',
  status           text not null default 'backlog'
                     check (status in ('backlog','todo','in-progress','in-review','done')),
  priority         text not null default 'medium' check (priority in ('high','medium','low')),
  assignee_id      uuid references public.profiles (id) on delete set null,
  due_date         timestamptz,
  start_time       text,
  duration_minutes integer,
  reminder_minutes integer,
  labels           text[] not null default '{}',
  position         integer not null default 0,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now()
);

create index tasks_project_status_idx on public.tasks (project_id, status, position);

-- SECURITY DEFINER: called from policies on project_members and tasks,
-- which are themselves RLS-protected — without this it would evaluate
-- under the caller's own restricted visibility instead of the true row.
create or replace function public.can_see_project(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.has_permission('members.manage') then true
      when exists (select 1 from public.projects p
                    where p.id = proj_id and p.restricted = false) then true
      when exists (select 1 from public.project_members m
                    where m.project_id = proj_id and m.user_id = auth.uid()) then true
      else false
    end;
$$;

-- Mirrors projectIsViewerOnly, lib/store.tsx:200-204.
create or replace function public.project_is_viewer_only(proj_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.has_permission('members.manage') then false
      when not exists (select 1 from public.projects p
                        where p.id = proj_id and p.restricted = true) then false
      else not exists (select 1 from public.project_members m
                        where m.project_id = proj_id
                          and m.user_id = auth.uid()
                          and m.level = 'editor')
    end;
$$;

-- Bar for managing a project's own access/membership (fixes Defect 1).
-- Mirrors the app's setProjectAccess guard (lib/store.tsx:903-905), plus
-- two bypasses that guard alone doesn't express but the rule requires:
-- members.manage always wins, and a project's own creator may always
-- manage it — which is also what makes the bootstrap case work, since a
-- brand-new restricted project's creator has no project_members row yet
-- and so cannot satisfy can_see_project()/not-viewer-only on their own.
create or replace function public.project_is_manageable(target_project_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id
      and (
        public.has_permission('members.manage')
        or p.created_by = auth.uid()
        or (
          public.has_permission('project.create')
          and public.can_see_project(p.id)
          and not public.project_is_viewer_only(p.id)
        )
      )
  );
$$;

alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;

create policy projects_read on public.projects
  for select to authenticated using (public.can_see_project(id));

-- Defect 2 fix: bind created_by so a project can't be attributed to
-- someone else.
create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    public.has_permission('project.create')
    and created_by = auth.uid()
  );

create policy projects_update on public.projects
  for update to authenticated
  using (public.has_permission('project.create')
         and public.can_see_project(id)
         and not public.project_is_viewer_only(id))
  with check (public.has_permission('project.create'));

create policy projects_delete on public.projects
  for delete to authenticated using (public.has_permission('project.delete'));

create policy project_members_read on public.project_members
  for select to authenticated using (public.can_see_project(project_id));

-- Defect 1 fix: split the brief's `for all` project_members_write into
-- explicit insert/update/delete, each scoped to the specific project via
-- project_is_manageable rather than a global permission check. select is
-- governed solely by project_members_read above.
create policy project_members_insert on public.project_members
  for insert to authenticated
  with check (public.project_is_manageable(project_members.project_id));

create policy project_members_update on public.project_members
  for update to authenticated
  using (public.project_is_manageable(project_members.project_id))
  with check (public.project_is_manageable(project_members.project_id));

create policy project_members_delete on public.project_members
  for delete to authenticated
  using (public.project_is_manageable(project_members.project_id));

create policy tasks_read on public.tasks
  for select to authenticated using (public.can_see_project(project_id));

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (public.has_permission('task.create')
              and public.can_see_project(project_id)
              and not public.project_is_viewer_only(project_id));

create policy tasks_update on public.tasks
  for update to authenticated
  using (public.has_permission('task.edit')
         and public.can_see_project(project_id)
         and not public.project_is_viewer_only(project_id))
  with check (public.can_see_project(project_id));

create policy tasks_delete on public.tasks
  for delete to authenticated
  using (public.has_permission('task.delete')
         and public.can_see_project(project_id)
         and not public.project_is_viewer_only(project_id));
