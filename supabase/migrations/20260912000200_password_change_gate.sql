-- The password requirement was a gate with nothing behind it.
--
-- 20260911000100 is careful about exactly one half of the problem. It reasons
-- that "a gate the gated party can open is not a gate", and so refuses to let
-- the app clear `must_change_password` at all: a trigger on
-- `auth.users.encrypted_password` clears it, transaction-locally, and nothing
-- else can. That half is sound and this migration does not touch it.
--
-- The other half was never built. No policy in this directory has ever read
-- `must_change_password`, so the requirement lives entirely in
-- `lib/auth.tsx:797,846` — it decides which screen to render. PostgREST was
-- never told. The account whose first password is still in place can skip the
-- app and read the whole workspace with that password:
--
--   * `session_is_assured()` does not stop them. It is true for anyone with no
--     verified factor, and somebody who has not yet replaced the password they
--     were handed has almost certainly not enrolled one either. The two gates
--     are disjoint, and this is the account that falls between them.
--   * That password is, by the migration's own description, "spoken aloud,
--     typed into somebody's notes, or pasted into a chat window", and known to
--     the admin who issued it. It is the one credential in the system that is
--     expected to leak.
--
-- So the flag stops the UI and not the API — QA-104's finding, one table over.
-- The shape of the answer is QA-104's too: a restrictive policy, ANDed onto
-- every permissive one, adding "...and they have replaced the password they
-- were given" without restating a single existing predicate.

-- `security definer` for the reason `session_is_assured()` is: the policy this
-- backs sits ON `profiles`, and a policy that read `profiles` as the caller
-- would recurse into itself. Definer bypasses RLS, so the read inside is the
-- table itself, not the policy stack.
--
-- `stable`, called once per row-check, and the answer cannot change within a
-- statement.
--
-- TRUE WHEN THERE IS NO PROFILE AT ALL, which is deliberate and matches
-- `session_is_assured()`'s shape ("true unless..."). A session with no profile
-- row is already refused everywhere it matters — every other policy in this
-- directory keys off a role or a membership it does not have — and making
-- this function the place that fails that case would hide the real reason
-- behind a confusing one. It answers the question it is named for, only.
create or replace function public.password_is_current()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.must_change_password
  );
$$;

revoke all on function public.password_is_current() from public;
grant execute on function public.password_is_current() to authenticated;

comment on function public.password_is_current() is
  'False while this account still holds the password an admin handed it — i.e. '
  'someone who has not finished signing in. Cleared only by a real password '
  'change (20260911000100). See 20260912000200.';

-- =====================================================================
-- Every table but one
-- =====================================================================
--
-- The same explicit list as 20260910004000, for the same reason it gave — a
-- table belongs here by decision, not by sweep — and now with
-- `public.gate_coverage()` below to notice when the decision was skipped.
-- `profiles` is absent on purpose and handled separately.
do $$
declare
  t text;
begin
  foreach t in array array[
    'roles',
    'projects', 'project_members', 'project_attachments',
    'channels', 'channel_members', 'conversations',
    'messages', 'message_attachments', 'reactions', 'read_state',
    'dms', 'dm_members',
    'tasks', 'task_collaborators', 'task_attachments',
    'task_sets', 'task_set_items',
    'attachments', 'activities', 'statuses'
  ] loop
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
-- The one carve-out, and why it is this narrow
-- =====================================================================
--
-- A gated session has to be able to read ONE row: its own profile, because
-- `must_change_password` is on it and `lib/auth.tsx` cannot know it is gated
-- without reading the flag. Gate `profiles` outright and the login screen can
-- no longer tell "replace your password" from "this account has no profile",
-- which is a real and differently-handled case (see the runbook).
--
-- SELF ONLY, not the whole table. The looser carve-out — let a gated session
-- read `profiles` entirely — would hand the workspace directory (every name,
-- handle and email) to a password that is expected to have leaked. That is a
-- smaller prize than the workspace, which is exactly why it would be easy to
-- wave through. The login flow needs one row, so it gets one row.
--
-- THE CARVE-OUT COVERS WRITES TOO, and that is a decision rather than an
-- oversight. The tighter rule — read your row, write nothing — was written
-- first and thrown away for two reasons:
--
--   * Every field on `profiles` that could matter to a gated session is
--     already held by a trigger, each with a sentence it was given on purpose:
--     `must_change_password` by guard_must_change_password (20260911000100),
--     `role_id` by block_self_role_change (20260906000100), `mfa_required` by
--     guard_mfa_required (20260908000800). What a blanket write refusal adds
--     on top of those is the ability to stop somebody renaming themselves
--     while they are held at the password screen. That is not the attack.
--   * It would take those sentences away. A restrictive `with check` fails
--     first and fails generically, so the gated party's attempt to clear their
--     own flag — the exact attack 20260911000100 was built for, and the first
--     assertion in tests/rls/must-change-password.test.ts — would stop
--     answering "Only an admin can change the password requirement" and start
--     answering "new row violates row-level security policy". A worse refusal
--     for the same refusal.
--
-- The division of labour is: the trigger guards the fields, this policy guards
-- the workspace.
drop policy if exists require_password_change on public.profiles;
create policy require_password_change on public.profiles as restrictive to authenticated
  using (public.password_is_current() or id = auth.uid())
  with check (public.password_is_current() or id = auth.uid());

-- The bytes, on the same reasoning as `require_assurance_objects`: a gate that
-- withheld the rows but served the documents would not be a gate.
drop policy if exists require_password_change_objects on storage.objects;
create policy require_password_change_objects on storage.objects
  as restrictive to authenticated
  using (
    bucket_id not in ('project-files', 'task-files', 'message-files')
    or public.password_is_current()
  )
  with check (
    bucket_id not in ('project-files', 'task-files', 'message-files')
    or public.password_is_current()
  );

-- =====================================================================
-- The definer hole, again
-- =====================================================================
--
-- `find_or_create_dm` was brought inside the assurance gate one migration ago
-- (20260912000100) because RLS is not consulted inside a SECURITY DEFINER
-- function, so no restrictive policy can reach its three inserts. Everything
-- true there is true here: without the second check below, a gated session can
-- open a DM by RPC while every policy above says no.
--
-- Replaced in full rather than patched, because that is the only way Postgres
-- offers. The body is 20260912000100's, plus one check. The two refusals say
-- the same sentence on purpose — "finish signing in" is the whole truth from
-- where the caller stands, and which of the two steps is outstanding is not
-- this function's news to break.
create or replace function public.find_or_create_dm(other_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_key text;
  v_id  text;
begin
  if v_me is null then
    raise exception 'You must be signed in to open a direct message';
  end if;
  -- RLS is not consulted inside a definer function, so the restrictive
  -- policies cannot do either of these for us. See the headers of
  -- 20260912000100 and this file.
  if not public.session_is_assured() then
    raise exception 'Finish signing in first';
  end if;
  if not public.password_is_current() then
    raise exception 'Finish signing in first';
  end if;
  if find_or_create_dm.other_user_id is null
     or find_or_create_dm.other_user_id = v_me then
    raise exception 'A direct message needs someone else';
  end if;
  if not public.has_permission('message.send') then
    raise exception 'You do not have permission to send messages';
  end if;
  -- Deliberately the same message as the not-found case: telling an attacker
  -- apart "no such person" from "a person you may not see" is the oracle.
  if not public.can_see_profile(find_or_create_dm.other_user_id) then
    raise exception 'That person is not on this team';
  end if;

  v_key := public.dm_pair_key(v_me, find_or_create_dm.other_user_id);

  select d.id into v_id from public.dms d where d.pair_key = v_key;
  if v_id is not null then
    return v_id;
  end if;

  -- Matches uid() in lib/store.tsx: '<prefix>_<uuid>'.
  v_id := 'd_' || gen_random_uuid()::text;
  begin
    insert into public.conversations (id, kind) values (v_id, 'dm');
    insert into public.dms (id) values (v_id);
    insert into public.dm_members (dm_id, user_id)
    values (v_id, v_me), (v_id, find_or_create_dm.other_user_id);
  exception when unique_violation then
    select d.id into v_id from public.dms d where d.pair_key = v_key;
    if v_id is null then
      raise;
    end if;
  end;

  return v_id;
end;
$$;

-- =====================================================================
-- The control that would have caught all four of these
-- =====================================================================
--
-- Both gates are hand-written table lists, and both were wrong: 20260910004000
-- missed three tables (one of them added in the very next migration), and this
-- gate did not exist at all. The suite stayed green through both, because the
-- only assertion about either one named `profiles` and every other table was
-- nobody's business.
--
-- So: one function listing every RLS-enabled table in `public` beside whether
-- each gate covers it. It returns the covered rows too, on purpose — a
-- function that returned only failures would satisfy its test just as happily
-- by finding no tables at all (a typo in the schema name, a `relkind` that
-- stopped matching) and read as "everything is fine". Listing everything makes
-- the row count its own control.
--
-- `polpermissive` false IS restrictive. A permissive policy of either name
-- would be worse than none: it would read as coverage in every grep and OR
-- itself alongside the rules it was meant to narrow.
--
-- SERVICE-ROLE ONLY, on the `orphaned_attachments` pattern
-- (20260909001000:188) and for its reason: it reads the catalogue, which is a
-- map of the schema, and no browser session has business asking for one. The
-- revoke is what makes that true — a function is executable by PUBLIC by
-- default, and `security definer` would hand every caller the owner's view of
-- pg_policy along with it.
create or replace function public.gate_coverage()
returns table (table_name text, require_assurance boolean, require_password_change boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.relname::text,
    exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = c.oid
        and p.polname = 'require_assurance'
        and not p.polpermissive
    ),
    exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = c.oid
        and p.polname = 'require_password_change'
        and not p.polpermissive
    )
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
  order by 1;
$$;

revoke execute on function public.gate_coverage() from public, anon, authenticated;
grant execute on function public.gate_coverage() to service_role;

comment on function public.gate_coverage() is
  'Schema self-check: every RLS-enabled public table and whether each gate '
  'covers it. Every row is expected to be true on both — asserted by '
  'tests/rls/gate-coverage.test.ts.';
