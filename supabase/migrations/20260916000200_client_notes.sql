-- Notes become a log.
--
-- `project_client_info.notes` was one text box. What the case work needs is a
-- record of what was known when: each entry carries who wrote it and when,
-- set by the database rather than the client, and nothing can be edited or
-- removed afterwards — enforced here by having no update and no delete policy
-- at all, not by hiding buttons.
--
-- Modelled on `project_client_documents` (20260914000200): a child of the
-- project rather than of the info row, split-per-verb policies with
-- table-qualified columns, both restrictive gates, realtime publication.
--
-- ORDER MATTERS BELOW. The existing text is backfilled as each client's first
-- entry BEFORE the stamping trigger exists, so it keeps the row's real
-- `updated_at` and `updated_by`; created afterwards, the trigger would stamp
-- every backfilled entry with now() and a null author.
create table if not exists public.project_client_notes (
  id         text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  body       text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

create index if not exists project_client_notes_project_idx
  on public.project_client_notes (project_id, created_at);

-- Backfill: one entry per client that had text.
insert into public.project_client_notes (id, project_id, body, created_at, created_by)
select 'n_' || replace(gen_random_uuid()::text, '-', ''),
       i.project_id, i.notes, i.updated_at, i.updated_by
from public.project_client_info i
where length(btrim(i.notes)) > 0
  and not exists (select 1 from public.project_client_notes n where n.project_id = i.project_id);

-- Now the trigger. The client never names itself or picks its time.
create or replace function public.stamp_client_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_at = now();
  new.created_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists project_client_notes_stamp on public.project_client_notes;
create trigger project_client_notes_stamp
  before insert on public.project_client_notes
  for each row execute function public.stamp_client_note();

alter table public.project_client_notes enable row level security;

drop policy if exists client_notes_read on public.project_client_notes;
create policy client_notes_read on public.project_client_notes
  for select to authenticated
  using (public.can_see_project(project_client_notes.project_id));

drop policy if exists client_notes_insert on public.project_client_notes;
create policy client_notes_insert on public.project_client_notes
  for insert to authenticated
  with check (
    public.can_see_project(project_client_notes.project_id)
    and not public.project_is_viewer_only(project_client_notes.project_id)
  );
-- No UPDATE and no DELETE policy, deliberately: an entry is a record.

do $$
declare t text;
begin
  foreach t in array array['project_client_notes'] loop
    execute format('drop policy if exists require_assurance on public.%I', t);
    execute format(
      'create policy require_assurance on public.%I as restrictive to authenticated '
      'using (public.session_is_assured()) with check (public.session_is_assured())', t);
    execute format('drop policy if exists require_password_change on public.%I', t);
    execute format(
      'create policy require_password_change on public.%I as restrictive to authenticated '
      'using (public.password_is_current()) with check (public.password_is_current())', t);
  end loop;
end
$$;

alter publication supabase_realtime add table public.project_client_notes;
alter table public.project_client_notes replica identity full;

-- The text box is gone. A dead column is written by the next person who
-- forgets it is dead.
alter table public.project_client_info drop column if exists notes;
