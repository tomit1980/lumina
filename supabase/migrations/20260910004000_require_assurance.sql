-- QA-104 — the second factor was decorative at the data layer.
--
-- THE FINDING, established against lumina-dev rather than reasoned about. A
-- throwaway account was created, a real TOTP factor enrolled and VERIFIED, and
-- the account then signed in with the password alone:
--
--     STATE  password-only session: current=aal1 next=aal2
--     READS  profiles 3 · projects 2 · channels 3 · tasks 1 · activities 5
--
-- Five of six tables returned real rows. (`messages` was empty because that
-- account belonged to nothing, not because anything refused it.) No policy in
-- this directory referenced `aal`, so RLS could not tell a session that had
-- answered the second factor from one that had not, and there is no
-- Supabase-side enforcement standing in for the missing predicate.
--
-- The client half (lib/backend/supabase/assurance.ts) stops the app fetching
-- the workspace behind the login screen. This is the half that matters: a
-- client-side check is a convenience, and anyone holding the aal1 token can
-- call PostgREST by hand.
--
-- WHY RESTRICTIVE POLICIES, rather than editing the twenty-odd policies that
-- already exist. A restrictive policy is ANDed with the permissive ones, so
-- each table gains "...and the session is assured" without a single existing
-- predicate being restated. Restating them would mean copying twenty
-- carefully-reasoned rules into this file and hoping every one survived the
-- trip — the kind of edit that silently widens an access rule. Nothing below
-- grants anything; every one of them can only take away.

-- `security definer` because `auth.mfa_factors` is not readable by the
-- `authenticated` role, and `stable` because it is called once per row-check
-- and the answer cannot change within a statement.
create or replace function public.session_is_assured()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    -- The second factor has been answered.
    coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    -- ...or there is no second factor to answer. This is the branch that
    -- keeps the app working for almost everybody: an account with no verified
    -- factor has no second step pending, and holding it back would lock out
    -- every ordinary user — including every account the RLS suite signs in
    -- as, which is exactly why that suite staying green is the control for
    -- this migration.
    or not exists (
      select 1
      from auth.mfa_factors f
      where f.user_id = auth.uid()
        and f.status = 'verified'
    );
$$;

revoke all on function public.session_is_assured() from public;
grant execute on function public.session_is_assured() to authenticated;

comment on function public.session_is_assured() is
  'True unless this is a password-only (aal1) session on an account that has a '
  'verified second factor — i.e. someone who has not finished signing in. See '
  'QA-104 in docs/superpowers/qa/2026-09-10-code-findings.md.';

-- Every table holding workspace data. The list is explicit rather than
-- "everything in public": a table added later should have to be considered,
-- not silently swept in or silently missed.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'roles',
    'projects', 'project_members', 'project_attachments',
    'channels', 'channel_members',
    'messages', 'reactions', 'read_state',
    'dms', 'dm_members',
    'tasks', 'task_collaborators', 'task_attachments',
    'attachments', 'activities'
  ] loop
    execute format('drop policy if exists require_assurance on public.%I', t);
    execute format(
      'create policy require_assurance on public.%I as restrictive to authenticated '
      'using (public.session_is_assured()) with check (public.session_is_assured())',
      t
    );
  end loop;
end
$$;

-- Storage objects too: the buckets hold the documents themselves, and a
-- half-signed-in session that could not read the `attachments` row but could
-- still pull the bytes would be the same hole one layer down.
drop policy if exists require_assurance_objects on storage.objects;
create policy require_assurance_objects on storage.objects
  as restrictive to authenticated
  using (
    bucket_id not in ('project-files', 'task-files', 'message-files')
    or public.session_is_assured()
  )
  with check (
    bucket_id not in ('project-files', 'task-files', 'message-files')
    or public.session_is_assured()
  );
