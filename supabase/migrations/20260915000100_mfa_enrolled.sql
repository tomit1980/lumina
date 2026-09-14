-- Let the Members screen say who actually has an authenticator.
--
-- THE DEFECT. `twoFactorStatus` could only ever answer about the signed-in
-- user. `auth.mfa_factors` is not readable by the `authenticated` role, and
-- listing somebody else's factors is an `auth.admin` call needing the secret
-- key -- which bypasses every policy in this schema and must never reach a
-- browser bundle. So the badge fell back to `profiles.mfa_required` and read
-- "2FA pending" about people who had enrolled months earlier, for as long as
-- the requirement stayed on. It was not a stale value; it was a guess wearing
-- the clothes of a fact.
--
-- WHY A DEFINER FUNCTION IS THE RIGHT SHAPE. `public.session_is_assured()`
-- (20260910004000) already reads this same table for exactly this reason, and
-- is the precedent followed here. No policy can gate `auth.mfa_factors` from
-- the app's side, because the app has no right to the table at all; a definer
-- function is the only way to answer a question about it without handing over
-- the key that answers every other question too.
--
-- WHAT IT GIVES AWAY, EXACTLY. One bit per person: they have a verified factor
-- or they do not. No factor id, no secret, no friendly name, no timestamp --
-- ids and nothing else, which is all the screen renders. The rows it returns
-- are about people the caller already administers.
--
-- THE PERMISSION CHECK IS IN THE BODY, and it has to be. RLS is not consulted
-- inside a `security definer` function, so no policy above this could restrict
-- it -- the same trap `find_or_create_dm` has been rewritten for twice. The bar
-- is `members.manage`, which is already exactly who is shown the two-factor
-- control at all (components/settings/workspace-people.tsx), so this widens
-- nothing that was not already on that screen.
--
-- A caller without the permission gets NO ROWS rather than an exception. That
-- is how every read in this schema refuses, and it is indistinguishable from a
-- workspace where nobody has enrolled -- which is the correct thing for
-- somebody who is not shown the badge to be unable to tell apart.
--
-- KNOWING IS NOT ACTING. An admin still cannot remove another person's
-- authenticator; that remains an `auth.admin` call, and the screen now says so
-- instead of offering a button that would quietly do nothing. See
-- docs/runbooks/creating-a-user.md.
create or replace function public.mfa_enrolled_ids()
returns table (user_id uuid)
language sql
stable
security definer
-- Empty search_path, so every reference below is schema-qualified and nothing
-- here can be redirected by a caller's own path.
set search_path = ''
as $$
  select distinct f.user_id
  from auth.mfa_factors f
  where f.status = 'verified'
    and public.has_permission('members.manage');
$$;

-- `revoke ... from public` does NOT revoke from `anon`. Supabase ships default
-- privileges on the `public` schema granting EXECUTE on every new function to
-- `anon`, `authenticated` and `service_role` BY NAME; revoking from PUBLIC
-- removes only the implicit grant every function is born with. The familiar
-- pair -- revoke from public, grant to authenticated -- therefore leaves a
-- signed-out caller able to enter the body, where `has_permission` would refuse
-- them on `auth.uid()` being null.
--
-- That refusal would be correct today and is not the point. The door should not
-- depend on the order of lines inside the room. This is the trap
-- 20260914000400_client_rpc_anon.sql was written to close for the client
-- functions, found by a probe rather than by reading the code, and it is closed
-- here at the same time as the function is created rather than afterwards.
revoke all on function public.mfa_enrolled_ids() from public;
revoke all on function public.mfa_enrolled_ids() from anon;
grant execute on function public.mfa_enrolled_ids() to authenticated;

comment on function public.mfa_enrolled_ids() is
  'The ids of users with a verified MFA factor, for callers holding '
  'members.manage. Returns no rows to anybody else. Reads auth.mfa_factors, '
  'which the authenticated role cannot read directly.';
