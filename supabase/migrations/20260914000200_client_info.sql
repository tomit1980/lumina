-- Client Info: the case record behind a project.
--
-- Every project here is one client's pension-release case, and the facts that
-- decide the case - who they are, which super fund, what they were diagnosed
-- with, which documents have arrived, whether the contract is signed - live in
-- nobody's system. They are in a phone call and somebody's memory. This is the
-- record.
--
-- A RELATED TABLE, NOT A JSON COLUMN ON `projects`. A blob cannot be
-- constrained, cannot be typed, cannot be indexed, and - the reason that
-- actually decides it - cannot be given its own RLS. The password lives here
-- too, and a JSON column would have made "who may read the client's details"
-- exactly "who may read the project", with no seam to tighten later.
--
-- ONE ROW PER PROJECT, KEYED BY THE PROJECT. The one-to-one is the primary
-- key, not a convention: there is no id of its own, so a second row for the
-- same project is not something the application has to remember not to write.
-- Delete the project and both tables go with it.
--
-- NOTHING IS BACKFILLED. No row exists until somebody types something; the app
-- renders an empty record for a project that has none, and the first save is
-- an upsert. Every project that already exists gets the tab and an empty form,
-- which is the true state of affairs rather than a row full of defaults
-- pretending to be data.

-- =====================================================================
-- 1. The record
-- =====================================================================

create table if not exists public.project_client_info (
  project_id         text primary key references public.projects(id) on delete cascade,

  -- Personal details.
  full_name          text not null default '',
  -- `date`, not `timestamptz`, and this is the whole defence against the bug
  -- class that has bitten `Task.dueDate` twice. A date of birth is not an
  -- instant; giving it one means a timezone, and a timezone means the 3rd
  -- becomes the 2nd for somebody. The app carries these as 'YYYY-MM-DD'
  -- strings end to end and never constructs a Date from one.
  date_of_birth      date,
  -- Free text on purpose: international numbers arrive as '+61 412 345 678',
  -- '(02) 9876 5432' and worse, and a column that normalised them would lose
  -- the extension, the country code, or the note the caller wrote beside it.
  -- Shape is checked in the client, where a refusal can say what it wants.
  phone              text not null default '',
  email              text not null default '',
  address            text not null default '',

  -- Super / case details.
  super_company      text not null default '',
  member_id          text not null default '',
  -- `numeric`, never a float: this is money, and 0.1 + 0.2 is a bug people
  -- notice. Nullable because "not yet known" and "zero dollars" are different
  -- answers and a default of 0 would erase the difference.
  amount             numeric(14,2),
  -- Stored beside the amount rather than assumed. The workspace is Australian
  -- and the UI writes '$', but a bare number with an implied currency is how a
  -- system ends up unable to tell A$ from US$ the first time one client is
  -- offshore. ISO 4217 is three characters, so the column is three characters.
  currency           char(3) not null default 'AUD'
                       check (currency ~ '^[A-Z]{3}$'),
  diagnosis          text not null default '',
  last_day_of_work   date,
  employer_name      text not null default '',

  -- The contract.
  contract_signed    boolean not null default false,

  -- Updated contact details. SEPARATE COLUMNS, and that is the requirement
  -- rather than an implementation choice: the originals are what was on the
  -- application form, and a new number must never overwrite the number the
  -- fund has on file. Both are kept, both are shown.
  new_phone          text not null default '',
  new_email          text not null default '',

  notes              text not null default '',

  -- The client's account password lives in Vault. THIS COLUMN IS A POINTER AND
  -- NEVER A VALUE - see section 5. It is nullable, and null means "no password
  -- stored", which is also what every existing project has.
  password_secret_id uuid,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles(id) on delete set null
);

-- Documents as rows, not as five boolean columns.
--
-- The spec asks for five and says more will follow. Five columns would make
-- the sixth a migration, a type regeneration, a deploy, and an edit to every
-- layer in between; a row makes it one line in a client-side constant. The
-- table accepts any `document_type` on purpose - which kinds exist is a
-- product decision, and the database has no opinion worth enforcing here.
--
-- A row is only written once somebody touches that checkbox, so absence means
-- "not received", the same as `received = false`. The UI reads both the same
-- way, and "3 / 5 received" counts the trues rather than the rows.
create table if not exists public.project_client_documents (
  project_id    text not null references public.projects(id) on delete cascade,
  document_type text not null,
  received      boolean not null default false,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null,
  primary key (project_id, document_type)
);

-- =====================================================================
-- 2. Who last touched it, according to the database
-- =====================================================================
--
-- `created_by`/`uploaded_by` elsewhere in this schema are set by the app and
-- policed by a policy ("...with check (created_by = auth.uid())"). That works,
-- but it means the client names itself and the database checks the name.
--
-- Here the client does not get to name itself at all. The trigger overwrites
-- both columns on every insert and update, so `updated_by` is what the session
-- actually was, not what the request claimed - which is the difference between
-- an audit trail and a field. It also means the app never sends them, so
-- there is no fourth place for the two to drift apart.
create or replace function public.touch_client_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists project_client_info_touch on public.project_client_info;
create trigger project_client_info_touch
  before insert or update on public.project_client_info
  for each row execute function public.touch_client_record();

drop trigger if exists project_client_documents_touch on public.project_client_documents;
create trigger project_client_documents_touch
  before insert or update on public.project_client_documents
  for each row execute function public.touch_client_record();

-- =====================================================================
-- 3. Row-level security
-- =====================================================================
--
-- READ is `can_see_project`, the same bar as the project's tasks and files.
-- WRITE is editor access to that project: `can_see_project and not
-- project_is_viewer_only`. That pair is exactly what the app calls "editor",
-- and `project_is_viewer_only` already returns false for anyone holding
-- `members.manage`, so admins pass without a clause of their own.
--
-- NO PERMISSION CHECK ALONGSIDE IT, unlike `tasks_insert`'s
-- `has_permission('task.create')`. The decision was "anyone with editor access
-- to the project", and adding `project.create` would have meant an editor who
-- may edit every task on a case may not record the client's phone number.
--
-- Split per verb, never `for all`: 20260906000350 is the migration that exists
-- because a `for all` policy silently granted SELECT beside a stricter read
-- policy and undid it.
--
-- Columns are table-qualified throughout. An unqualified `project_id` inside a
-- policy on a table that has one resolves to the row's column here, but it
-- stops doing so the moment a subquery is added, and the failure is silent.
alter table public.project_client_info      enable row level security;
alter table public.project_client_documents enable row level security;

drop policy if exists client_info_read on public.project_client_info;
create policy client_info_read on public.project_client_info
  for select to authenticated
  using (public.can_see_project(project_client_info.project_id));

drop policy if exists client_info_insert on public.project_client_info;
create policy client_info_insert on public.project_client_info
  for insert to authenticated
  with check (
    public.can_see_project(project_client_info.project_id)
    and not public.project_is_viewer_only(project_client_info.project_id)
  );

drop policy if exists client_info_update on public.project_client_info;
create policy client_info_update on public.project_client_info
  for update to authenticated
  using (
    public.can_see_project(project_client_info.project_id)
    and not public.project_is_viewer_only(project_client_info.project_id)
  )
  with check (
    public.can_see_project(project_client_info.project_id)
    and not public.project_is_viewer_only(project_client_info.project_id)
  );

-- No DELETE policy on either table, deliberately. The record's lifetime is the
-- project's: it arrives with the first edit and leaves with the cascade. There
-- is no screen that deletes one, so a policy permitting it would only ever be
-- exercised by something that had gone wrong.

drop policy if exists client_documents_read on public.project_client_documents;
create policy client_documents_read on public.project_client_documents
  for select to authenticated
  using (public.can_see_project(project_client_documents.project_id));

drop policy if exists client_documents_insert on public.project_client_documents;
create policy client_documents_insert on public.project_client_documents
  for insert to authenticated
  with check (
    public.can_see_project(project_client_documents.project_id)
    and not public.project_is_viewer_only(project_client_documents.project_id)
  );

drop policy if exists client_documents_update on public.project_client_documents;
create policy client_documents_update on public.project_client_documents
  for update to authenticated
  using (
    public.can_see_project(project_client_documents.project_id)
    and not public.project_is_viewer_only(project_client_documents.project_id)
  )
  with check (
    public.can_see_project(project_client_documents.project_id)
    and not public.project_is_viewer_only(project_client_documents.project_id)
  );

-- =====================================================================
-- 4. Both gates, by name
-- =====================================================================
--
-- `require_assurance` (20260910004000) and `require_password_change`
-- (20260912000200) are restrictive policies ANDed onto every permissive one,
-- and both keep hand-written table lists so that a new table "should have to
-- be considered, not silently swept in or silently missed". This is that
-- consideration, and `public.gate_coverage()` plus tests/rls/gate-coverage
-- will fail the suite if it is ever dropped.
--
-- It matters more here than on most tables. A half-signed-in session - aal1
-- with a factor enrolled, or still holding the password an admin handed it -
-- must not be able to read a client's date of birth and diagnosis any more
-- than it can read the board.
do $$
declare
  t text;
begin
  foreach t in array array['project_client_info', 'project_client_documents'] loop
    execute format('drop policy if exists require_assurance on public.%I', t);
    execute format(
      'create policy require_assurance on public.%I as restrictive to authenticated '
      'using (public.session_is_assured()) with check (public.session_is_assured())',
      t
    );
    execute format('drop policy if exists require_password_change on public.%I', t);
    execute format(
      'create policy require_password_change on public.%I as restrictive to authenticated '
      'using (public.password_is_current()) with check (public.password_is_current())',
      t
    );
  end loop;
end
$$;

-- =====================================================================
-- 5. The one secret, and the two doors to it
-- =====================================================================
--
-- Clients hand over the login to their super fund's member portal. It is a
-- credential to somebody else's system, chosen by somebody who very likely
-- uses it elsewhere, and it is the one field on this record that a plain
-- column would have been indefensible for.
--
-- SO IT IS NOT A COLUMN. `password_secret_id` points at `vault.secrets`; the
-- value is encrypted with a key that is not in the database (20260914000100
-- proves the round trip works here). What that buys and what it does not is
-- written out in that migration's header - read it before relying on this.
--
-- The two functions below are the only way in or out, and each is `security
-- definer` because `vault` is owned by `supabase_admin` and no browser session
-- has rights there. Definer means RLS IS NOT CONSULTED INSIDE THEM - not the
-- table policies above, and not either restrictive gate. 20260912000100 and
-- 20260912000200 both exist because `find_or_create_dm` had exactly this hole.
-- So every check is re-stated inline below, in `assert_client_editor`.

-- The shared bar: signed in, both gates satisfied, and an editor on a project
-- that exists and that this caller can see.
--
-- ONE SENTENCE FOR EVERY REFUSAL THE CALLER COULD LEARN SOMETHING FROM. "No
-- such project", "a project you cannot see" and "a project you may only view"
-- all answer the same way, because the difference between the first two is an
-- oracle for which project ids exist - the reasoning `find_or_create_dm` uses
-- for `can_see_profile`. The two "finish signing in" cases are separate, since
-- that caller already knows which of their own sign-in steps is outstanding.
create or replace function public.assert_client_editor(p_project_id text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to do that';
  end if;
  -- RLS is not consulted inside a definer function, so the restrictive
  -- policies in section 4 cannot do either of these for us.
  if not public.session_is_assured() then
    raise exception 'Finish signing in first';
  end if;
  if not public.password_is_current() then
    raise exception 'Finish signing in first';
  end if;
  if p_project_id is null
     or not public.can_see_project(p_project_id)
     or public.project_is_viewer_only(p_project_id) then
    raise exception 'You cannot edit this project''s client details';
  end if;
end;
$$;

revoke all on function public.assert_client_editor(text) from public;
grant execute on function public.assert_client_editor(text) to authenticated;

-- Store, replace, or clear. `null` clears.
--
-- The old secret is DELETED rather than left behind. `vault.update_secret`
-- would work too, but delete-then-create means a cleared password has no
-- ciphertext anywhere rather than an unreferenced one, and "no row in
-- vault.secrets" is something a test can assert.
--
-- The activity line names no part of the value.
create or replace function public.set_client_password(
  p_project_id text,
  p_value      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  perform public.assert_client_editor(p_project_id);

  -- An empty string is a cleared password, not a password of length zero.
  -- Storing '' would leave `hasPassword` true and a Reveal button that
  -- revealed nothing.
  if p_value = '' then
    p_value := null;
  end if;

  select i.password_secret_id into v_old
    from public.project_client_info i
   where i.project_id = p_project_id;

  if p_value is not null then
    -- The name is unique per project and never contains the value. Vault
    -- requires names to be unique across the database, so the random suffix
    -- is what keeps a re-set from colliding with a secret whose delete is
    -- still in the same transaction.
    v_new := vault.create_secret(
      p_value,
      'lumina_client_password_' || p_project_id || '_' || gen_random_uuid()::text,
      'Client account password for Lumina project ' || p_project_id
    );
  end if;

  -- Upsert: the record may not exist yet, since it is created lazily by
  -- whichever edit comes first, and that edit may well be this one. The
  -- trigger in section 2 sets updated_at/updated_by either way.
  insert into public.project_client_info (project_id, password_secret_id)
  values (p_project_id, v_new)
  on conflict (project_id) do update
    set password_secret_id = excluded.password_secret_id;

  if v_old is not null then
    delete from vault.secrets where id = v_old;
  end if;

  insert into public.activities (id, ts, actor_id, text, kind, project_id)
  values (
    'a_' || gen_random_uuid()::text,
    now(),
    auth.uid(),
    case when p_value is null
      then 'cleared the client''s stored password'
      else 'set the client''s stored password'
    end,
    'project',
    p_project_id
  );
end;
$$;

revoke all on function public.set_client_password(text, text) from public;
grant execute on function public.set_client_password(text, text) to authenticated;

-- Reveal, and say so.
--
-- THE LOG IS WRITTEN BEFORE THE VALUE IS READ, and that ordering is the point
-- rather than a detail. Both statements are in one transaction, so a reveal
-- that reaches the caller has left a line behind it: there is no ordering of
-- failures in which somebody sees the password and the feed does not know.
--
-- The line names the project and the actor and nothing else. `activities.text`
-- is readable by everyone who can see the project, so a line quoting even part
-- of the value would undo the whole design.
--
-- Returns null when there is no password stored, which is not an error and not
-- a refusal - and still logs, because "who looked" is the question this
-- answers and an empty look is still a look.
create or replace function public.reveal_client_password(p_project_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_value text;
begin
  perform public.assert_client_editor(p_project_id);

  select i.password_secret_id into v_id
    from public.project_client_info i
   where i.project_id = p_project_id;

  insert into public.activities (id, ts, actor_id, text, kind, project_id)
  values (
    'a_' || gen_random_uuid()::text,
    now(),
    auth.uid(),
    'revealed the client''s stored password',
    'project',
    p_project_id
  );

  if v_id is null then
    return null;
  end if;

  select s.decrypted_secret into v_value
    from vault.decrypted_secrets s
   where s.id = v_id;

  return v_value;
end;
$$;

revoke all on function public.reveal_client_password(text) from public;
grant execute on function public.reveal_client_password(text) to authenticated;

-- The cascade takes the row when a project is deleted, and without this the
-- ciphertext would outlive it forever with nothing left pointing at it.
-- `before delete` so the id is still readable.
create or replace function public.drop_client_password_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.password_secret_id is not null then
    delete from vault.secrets where id = old.password_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists project_client_info_drop_secret on public.project_client_info;
create trigger project_client_info_drop_secret
  before delete on public.project_client_info
  for each row execute function public.drop_client_password_secret();

comment on column public.project_client_info.password_secret_id is
  'Pointer into vault.secrets. The password itself is never stored on this '
  'row, never returned by a select, and never present in a realtime payload. '
  'Read it with reveal_client_password(), which logs every call. '
  'See 20260914000100 and 20260914000200.';

-- =====================================================================
-- 6. Live updates
-- =====================================================================
--
-- toRealtimeEvent maps any table it does not recognise to `stale`, which the
-- store coalesces into a single hydrate through RLS - so being in the
-- publication is the entire change, and the payload itself is discarded
-- client-side rather than applied.
--
-- `replica identity full` puts the whole row in the WAL, which is the existing
-- pattern and is what makes deletes carry their old values. The password is
-- not on the row, so it is not in the stream; the rest is the same class of
-- personal data as `profiles.email`, which has been published since day one.
alter publication supabase_realtime add table public.project_client_info;
alter publication supabase_realtime add table public.project_client_documents;

alter table public.project_client_info      replica identity full;
alter table public.project_client_documents replica identity full;
