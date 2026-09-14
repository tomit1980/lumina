-- A way to ask whether a client password's ciphertext is still there.
--
-- WHY THIS EXISTS, and it is not a nicety. `vault` is not one of PostgREST's
-- exposed schemas, so NOBODY can reach `vault.secrets` over the API - not a
-- browser session, and not the service role either. That is the right posture
-- and 20260914000200 depends on it. But it also means the suite had no way to
-- check the two claims that matter most about the ciphertext's lifetime:
--
--   * that replacing or clearing a password really DELETES the old secret
--     rather than orphaning it, and
--   * that deleting a project takes its secret with it.
--
-- The first attempt at testing those asked `vault.secrets` through PostgREST
-- and got `PGRST106` (schema not exposed) - which supabase-js reports with
-- `data: null`. The test read that as "no rows found" and went green. It would
-- have gone green with every secret in the vault still sitting there, which is
-- precisely the verification-instrument-that-lies shape this project keeps
-- finding.
--
-- So: one function that answers the question honestly, and is itself the
-- maintenance tool for the problem it detects.
--
-- SERVICE-ROLE ONLY, on the `orphaned_attachments` (20260909001000) and
-- `gate_coverage` (20260912000200) pattern and for the same reason: it reads
-- across a security boundary, and no browser session has business asking. The
-- revoke is what makes that true - a function is executable by PUBLIC by
-- default, and `security definer` would otherwise hand every caller the
-- owner's view of the vault's catalogue.
--
-- IT RETURNS IDS AND NAMES, NEVER `decrypted_secret`. The question is "is this
-- ciphertext still here", and answering it does not require reading it. A
-- function that returned the value would be a third door to the password with
-- no activity line behind it.
create or replace function public.client_secret_ids()
returns table (secret_id uuid, secret_name text, referenced boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.name,
    exists (
      select 1 from public.project_client_info i
      where i.password_secret_id = s.id
    )
  from vault.secrets s
  where s.name like 'lumina\_client\_password\_%'
  order by s.created_at;
$$;

revoke execute on function public.client_secret_ids() from public, anon, authenticated;
grant execute on function public.client_secret_ids() to service_role;

comment on function public.client_secret_ids() is
  'Every client-password secret in the vault and whether a row still points at '
  'it. `referenced = false` is an orphan: ciphertext that outlived the record '
  'it belonged to, which set_client_password and the delete trigger both exist '
  'to prevent. Asserted by tests/rls/client-password.test.ts. Never returns '
  'the decrypted value. See 20260914000300.';
