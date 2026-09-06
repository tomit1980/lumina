-- Attachments, read state, and activities. Written directly against three
-- known defects in the task-7 brief rather than shipping them and patching
-- afterward (as tasks 5 and 6 had to be). All three trace back to the same
-- two root causes documented in 20260906000250_fix_conversation_policies.sql
-- and 20260906000350_fix_project_policies.sql:
--
--   (1) `for all` policies combine (OR) with the neighbouring read policy
--       (Postgres ORs multiple permissive policies together), so a `for
--       all ... using (<global permission>)` policy silently grants select
--       too, overriding a narrower read policy sitting right beside it.
--   (2) a `with check` that tests only a global permission, not the
--       specific row being written, lets a user attach a row to a resource
--       they cannot see.
--
-- Defect 1 (the brief's task_attachments_write): `for all using
-- (has_permission('task.edit'))`. task.edit is held by the ordinary
-- Member role, and `for all` leaks that clause into select, letting any
-- member enumerate the attachment links of tasks in restricted projects
-- they cannot see — defeating task_attachments_read beside it. Fixed by
-- splitting into insert/update/delete, each scoped to the specific task's
-- project via can_see_project + not project_is_viewer_only, mirroring
-- tasks_insert/tasks_update in 20260906000300_projects.sql.
--
-- Defect 2 (the brief's project_attachments_write and
-- message_attachments_write): also `for all`, for the same reason as
-- Defect 1. Split each into per-operation policies so select is governed
-- solely by its neighbouring read policy.
--
-- Defect 3 (the brief's attachments_insert): `with check (uploaded_by =
-- auth.uid())` alone doesn't stop a user inserting an attachment row full
-- stop -- nothing here references *where* it will be linked, because at
-- insert time no project_attachments/task_attachments/message_attachments
-- row exists yet to check against. can_see_attachment's own fallback
-- clause (a freshly uploaded row is visible to its uploader before it is
-- linked) already covers exactly this window, so requiring uploaded_by =
-- auth.uid() is both necessary and sufficient at the attachments-table
-- level: the row is visible to nobody else until a join-table insert
-- (task_attachments_insert / project_attachments_insert /
-- message_attachments_insert below) links it into something, and each of
-- those join-table policies independently requires the caller be able to
-- see (and, for project/task, manage) the target. So the real fix for
-- Defect 3 lives in the join-table INSERT policies, not in
-- attachments_insert itself: project_attachments_insert and
-- task_attachments_insert require project_is_manageable/an editable,
-- visible project (mirroring project_members_insert / tasks_insert), and
-- message_attachments_insert requires the caller be the message's own
-- author, which already implies can_see_conversation via
-- messages_insert. Kept attachments_insert unchanged from the brief.
create table public.attachments (
  id           text primary key,
  storage_path text not null,
  name         text not null,
  size         bigint not null default 0,
  mime         text not null default '',
  uploaded_by  uuid references public.profiles (id) on delete set null,
  uploaded_at  timestamptz not null default now(),
  edited_by    uuid references public.profiles (id) on delete set null,
  edited_at    timestamptz
);

create table public.project_attachments (
  project_id    text not null references public.projects (id) on delete cascade,
  attachment_id text not null references public.attachments (id) on delete cascade,
  primary key (project_id, attachment_id)
);

create table public.task_attachments (
  task_id       text not null references public.tasks (id) on delete cascade,
  attachment_id text not null references public.attachments (id) on delete cascade,
  primary key (task_id, attachment_id)
);

create table public.message_attachments (
  message_id        text not null references public.messages (id) on delete cascade,
  attachment_id     text not null references public.attachments (id) on delete cascade,
  source_project_id text references public.projects (id) on delete set null,
  primary key (message_id, attachment_id)
);

-- Replaces AppState.lastRead, which exposed everyone's read positions to everyone.
create table public.read_state (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id text not null references public.conversations (id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

create table public.activities (
  id       text primary key,
  ts       timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  text     text not null,
  kind     text not null check (kind in ('task','message','channel','member','project'))
);

create index activities_ts_idx on public.activities (ts desc);

-- An attachment is visible when anything it is attached to is visible.
-- SECURITY DEFINER: called from policies on attachments (and, via
-- attachments_read, effectively gates the join tables too) — without this
-- it would evaluate can_see_project/can_see_conversation under the
-- caller's own restricted visibility rather than the true row, and the
-- subqueries here against project_attachments/task_attachments/
-- message_attachments/tasks/messages/attachments would themselves be
-- filtered by the caller's RLS on those tables, undermining the check.
create or replace function public.can_see_attachment(att_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.project_attachments pa
             where pa.attachment_id = att_id and public.can_see_project(pa.project_id))
    or exists (select 1 from public.task_attachments ta
                join public.tasks t on t.id = ta.task_id
               where ta.attachment_id = att_id and public.can_see_project(t.project_id))
    or exists (select 1 from public.message_attachments ma
                join public.messages m on m.id = ma.message_id
               where ma.attachment_id = att_id
                 and public.can_see_conversation(m.conversation_id))
    -- A freshly uploaded row is visible to its uploader before it is linked.
    or exists (select 1 from public.attachments a
               where a.id = att_id and a.uploaded_by = auth.uid());
$$;

alter table public.attachments         enable row level security;
alter table public.project_attachments enable row level security;
alter table public.task_attachments    enable row level security;
alter table public.message_attachments enable row level security;
alter table public.read_state          enable row level security;
alter table public.activities          enable row level security;

create policy attachments_read on public.attachments
  for select to authenticated using (public.can_see_attachment(attachments.id));

create policy attachments_insert on public.attachments
  for insert to authenticated with check (uploaded_by = auth.uid());

create policy attachments_update on public.attachments
  for update to authenticated
  using (public.can_see_attachment(attachments.id) and public.has_permission('project.create'))
  with check (public.has_permission('project.create'));

create policy attachments_delete on public.attachments
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.has_permission('project.delete'));

create policy project_attachments_read on public.project_attachments
  for select to authenticated using (public.can_see_project(project_attachments.project_id));

-- Defect 2 fix: split the brief's `for all` project_attachments_write
-- into insert/update/delete (there are no other columns to update, but an
-- update policy is defined for parity with the shape of the other join
-- tables and to default-deny rather than silently allow). Each scoped to
-- the specific project via project_is_manageable, mirroring
-- project_members_insert/_update/_delete in 20260906000300_projects.sql,
-- rather than the brief's bare has_permission('project.create') +
-- not-viewer-only pair (which — like task_attachments_write below — does
-- not require the caller be able to see the project at all).
create policy project_attachments_insert on public.project_attachments
  for insert to authenticated
  with check (public.project_is_manageable(project_attachments.project_id));

create policy project_attachments_update on public.project_attachments
  for update to authenticated
  using (public.project_is_manageable(project_attachments.project_id))
  with check (public.project_is_manageable(project_attachments.project_id));

create policy project_attachments_delete on public.project_attachments
  for delete to authenticated
  using (public.project_is_manageable(project_attachments.project_id));

create policy task_attachments_read on public.task_attachments
  for select to authenticated
  using (exists (select 1 from public.tasks t
                  where t.id = task_attachments.task_id
                    and public.can_see_project(t.project_id)));

-- Defect 1 fix: split the brief's `for all using
-- (has_permission('task.edit'))` into insert/update/delete, each scoped to
-- the specific task's project (visible, and not viewer-only), mirroring
-- tasks_insert/tasks_update in 20260906000300_projects.sql, instead of a
-- bare global permission that every Member holds regardless of which
-- project the task belongs to.
create policy task_attachments_insert on public.task_attachments
  for insert to authenticated
  with check (
    public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_attachments.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  );

create policy task_attachments_update on public.task_attachments
  for update to authenticated
  using (
    public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_attachments.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  )
  with check (
    public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_attachments.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  );

create policy task_attachments_delete on public.task_attachments
  for delete to authenticated
  using (
    public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_attachments.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  );

create policy message_attachments_read on public.message_attachments
  for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_attachments.message_id
                    and public.can_see_conversation(m.conversation_id)));

-- Defect 2 fix: split the brief's `for all` message_attachments_write
-- into insert/update/delete, so select is governed solely by
-- message_attachments_read above. Each scoped to the specific message: you
-- may only attach to (or detach from) your own message, mirroring
-- messages_update/messages_delete's author_id = auth.uid() bar in
-- 20260906000200_conversations.sql.
create policy message_attachments_insert on public.message_attachments
  for insert to authenticated
  with check (exists (select 1 from public.messages m
                       where m.id = message_attachments.message_id
                         and m.author_id = auth.uid()));

create policy message_attachments_update on public.message_attachments
  for update to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_attachments.message_id
                    and m.author_id = auth.uid()))
  with check (exists (select 1 from public.messages m
                       where m.id = message_attachments.message_id
                         and m.author_id = auth.uid()));

create policy message_attachments_delete on public.message_attachments
  for delete to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_attachments.message_id
                    and m.author_id = auth.uid()));

-- Read positions are private, full stop. Correctly scoped as written in
-- the brief (user_id = auth.uid() on both using and with check, so `for
-- all` never leaks select to anyone else) — left unchanged.
create policy read_state_own on public.read_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DESIGN NOTE (flagged, not fixed here — see task-7-report.md): this
-- `using (true)` lets every signed-in user read the entire activity feed,
-- including free-text rows naming restricted projects and private
-- channels by name. activities carries no resource reference to filter
-- on, so a real fix is a schema change beyond this task's scope. Brief
-- implemented as written; see the report for the recommendation.
create policy activities_read on public.activities
  for select to authenticated using (true);

create policy activities_insert on public.activities
  for insert to authenticated with check (actor_id = auth.uid());
