-- Force a new teammate to replace the password they were handed.
--
-- Accounts are created from inside the app: an admin types a first password
-- and reads it out. That password has therefore been spoken aloud, typed into
-- somebody's notes, or pasted into a chat window, and the admin knows it. It is
-- a delivery mechanism, not a credential, and it should stop working the moment
-- the person is in.
--
-- WHY THE FLAG IS NOT CLEARED BY THE APP. The obvious build is: the browser
-- changes the password, then writes `must_change_password = false`. But
-- `profiles_update_self` (20260906000100_identity.sql) lets every member update
-- their own row, so that same call is available to the person being gated —
-- one PATCH and the requirement is gone, password untouched. A gate the gated
-- party can open is not a gate.
--
-- So nothing but a real password change clears it. A trigger on
-- `auth.users` watches `encrypted_password` and clears the flag when, and only
-- when, that column actually changes. The app never writes `false` at all.
--
-- This mirrors mfa_required (20260908000800_store_swap.sql section 6) in shape,
-- and differs in exactly that respect: there, the thing being required is
-- observable in another table, so a guard trigger was enough. Here the thing
-- being required lives in auth.users, which the browser cannot read.

-- =====================================================================
-- 1. The column
-- =====================================================================

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'Set when an admin creates the account; cleared only by profiles_clear_password_flag, which fires on a real auth.users password change.';

-- =====================================================================
-- 2. Who may set it
-- =====================================================================

-- Same reasoning as guard_mfa_required, including `coalesce(auth.role(), '')`:
-- auth.role() is NULL for writes arriving outside PostgREST, and
-- `null <> 'service_role'` is NULL, which plpgsql's `if` treats as false — a
-- bare comparison would wave those writes straight through.
--
-- The third exemption is the point of this file. `lumina.password_changed` is
-- set, transaction-locally, by the auth trigger below, immediately before its
-- own update. It is the only way the flag is ever cleared, and it cannot be
-- forged from a browser: PostgREST exposes no way to call set_config, and no
-- RPC in this schema does either.
create or replace function public.guard_must_change_password()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.must_change_password is distinct from old.must_change_password
     and coalesce(auth.role(), '') <> 'service_role'
     and coalesce(current_setting('lumina.password_changed', true), '') <> '1'
     and not public.has_permission('members.manage') then
    raise exception 'Only an admin can change the password requirement';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_must_change_password on public.profiles;
create trigger profiles_guard_must_change_password
  before update on public.profiles
  for each row execute function public.guard_must_change_password();

-- =====================================================================
-- 3. What clears it
-- =====================================================================

-- AFTER UPDATE OF encrypted_password, so the flag falls only to the event it
-- is about. `is distinct from` rather than `<>`: a NULL on either side must
-- count as a change, not evaluate to NULL and skip the clear.
--
-- security definer because the person changing their password holds no rights
-- over the flag — that is the whole design — and because GoTrue's own update
-- runs in a context that has no business carrying them.
--
-- The precedent for a trigger on auth.users is handle_new_user, in the same
-- migration that added mfa_required: this is not a new kind of reach into the
-- auth schema, it is the second use of an existing one.
create or replace function public.clear_password_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    perform set_config('lumina.password_changed', '1', true);
    update public.profiles
      set must_change_password = false
      where id = new.id and must_change_password;
  end if;
  return new;
end;
$$;

drop trigger if exists users_clear_password_flag on auth.users;
create trigger users_clear_password_flag
  after update of encrypted_password on auth.users
  for each row execute function public.clear_password_flag();
