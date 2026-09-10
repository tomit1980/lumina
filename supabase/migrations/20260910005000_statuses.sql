-- The board's columns become rows.
--
-- They were baked into three places that had to agree and could not be
-- edited: a five-member TypeScript union, a `STATUS_META` map carrying the
-- labels and dot colours, and the `check (status in (...))` on `tasks.status`
-- added in 20260906000300_projects.sql. A team could not rename a column to
-- match how they work, add one, or drop one they never use.
--
-- WHAT MAKES THIS CONTAINED. The five ids are preserved exactly — `backlog`,
-- `todo`, `in-progress`, `in-review`, `done` — so every existing row keeps
-- resolving without being rewritten, and the ~160 status literals across 21
-- test files stay valid. A rename changes `name`; `id` never moves. That one
-- decision is the difference between a contained change and a rewrite.
--
-- `move_task` and the `set_task_position` trigger needed no attention: both
-- are already fully parametric in the status and name none of them. The
-- `check` constraint was the only place in the database that knew the five.

create table if not exists public.statuses (
  id       text primary key,
  name     text not null,
  color    text not null default '#a1a1aa',
  position integer not null default 0,
  is_done  boolean not null default false
);

-- Exactly one column can mean "finished". Eighteen sites used to test the
-- literal `"done"`; they now ask which status carries this flag, so there had
-- better be exactly one to find. A partial unique index says so in the only
-- place that can actually enforce it.
create unique index if not exists statuses_single_done_idx
  on public.statuses ((is_done)) where is_done;

-- Today's five, with their existing ids, their `STATUS_META` labels, and the
-- hex equivalents of their old Tailwind dots (bg-zinc-400, bg-sky-500,
-- bg-amber-500, bg-violet-500, bg-emerald-500). `do nothing` rather than an
-- upsert, for the same reason the roles seed uses it: a workspace that has
-- since renamed a column must not have that undone by a redeploy.
insert into public.statuses (id, name, color, position, is_done) values
  ('backlog',     'Backlog',     '#a1a1aa', 0, false),
  ('todo',        'To Do',       '#0ea5e9', 1, false),
  ('in-progress', 'In Progress', '#f59e0b', 2, false),
  ('in-review',   'In Review',   '#8b5cf6', 3, false),
  ('done',        'Done',        '#10b981', 4, true)
on conflict (id) do nothing;

-- THE POINT OF THE WHOLE EXERCISE. With a foreign key, "you cannot delete a
-- status that still holds work" is enforced by Postgres rather than by
-- application code a raw PostgREST call could walk straight past. The
-- interface still reads the count first and explains, but it explains a rule
-- it does not have to be trusted to keep.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks
  add constraint tasks_status_fkey
  foreign key (status) references public.statuses (id) on delete restrict;

alter table public.statuses enable row level security;

-- Everyone signed in reads the columns — you cannot render a board without
-- them, and they carry nothing private.
drop policy if exists statuses_read on public.statuses;
create policy statuses_read on public.statuses
  for select to authenticated using (true);

-- Writing them is the Owner's one extra power. The permission does not exist
-- yet — it arrives with the Owner role in the next migration — so between the
-- two, nobody can edit a status. That is the safe direction: a window where
-- the feature is unavailable, not one where it is unguarded.
drop policy if exists statuses_write on public.statuses;
create policy statuses_write on public.statuses
  for all to authenticated
  using (public.has_permission('workspace.statuses'))
  with check (public.has_permission('workspace.statuses'));

-- Live updates: renaming a column has to reach every open board, or one
-- person's rename is invisible to everyone else until they reload. Same
-- reasoning as `profiles` and `roles` in 20260910003000_publish_identity.sql.
alter publication supabase_realtime add table public.statuses;
alter table public.statuses replica identity full;
