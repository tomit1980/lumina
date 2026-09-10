-- An Owner role, and a privilege boundary the database actually enforces.
--
-- THE PROBLEM THIS SOLVES, stated plainly, because it is not obvious. Admin
-- is the top role and is `locked`, so it looks like a ceiling. It is not:
-- Admin holds `members.manage`, which lets it create a role carrying any
-- permission and assign it to a colleague. Two admins could promote each
-- other to anything. So an Owner defined as "Admin plus one more permission"
-- would not be above Admin at all — an Admin could simply mint that
-- permission. The four rules below are what turn Owner into a real boundary,
-- and they are triggers rather than application code because the client is
-- one PostgREST call away from being bypassed entirely.

-- FIRST, a carve-out this migration needs and the next one will too.
--
-- `block_locked_role_update` (20260910001000_storage.sql) refuses any update
-- to a locked role, with an exemption for `auth.role() = 'service_role'`. A
-- MIGRATION is neither: it runs as `postgres`, where there is no auth context
-- at all, so `auth.role()` is null and the trigger fires — which is how the
-- first attempt at this file failed, on `set rank = 80 where id = 'admin'`.
--
-- Widened to "no authenticated user", which covers the service role, this
-- migration, and every future one, while leaving the rule exactly as strict
-- for anybody actually signed in. A schema change must be able to adjust a
-- seeded role; that is what schema changes are for.
create or replace function public.block_locked_role_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.role() = 'service_role' then
    return new;
  end if;
  if old.locked then
    raise exception 'Role "%" is locked and cannot be edited', old.name;
  end if;
  if new.locked is distinct from old.locked
     or new.is_system is distinct from old.is_system then
    raise exception 'A role''s built-in and locked flags cannot be changed';
  end if;
  return new;
end;
$$;

alter table public.roles
  add column if not exists rank integer not null default 50;

comment on column public.roles.rank is
  'Higher outranks lower. Owner 100, Admin 80, Member 40, Guest 20; a role '
  'someone creates defaults to 50. This is what "above" means for the four '
  'rules in this migration.';

update public.roles set rank = 80 where id = 'admin' and rank = 50;
update public.roles set rank = 40 where id = 'member' and rank = 50;
update public.roles set rank = 20 where id = 'guest'  and rank = 50;

-- The Owner role. `has_permission()` reads the permissions ARRAY and has
-- never honoured `locked`, so this array has to be complete or every policy
-- would refuse an Owner. Admin's array is left exactly as it is — notably
-- WITHOUT workspace.statuses, which is the one power that separates them.
insert into public.roles (id, name, description, color, permissions, is_system, locked, rank)
values (
  'owner', 'Owner',
  'Everything an admin can do, plus the workspace''s board columns.',
  '#f43f5e',
  array[
    'message.send', 'channel.create', 'channel.delete', 'message.deleteAny',
    'task.create', 'task.edit', 'task.move', 'task.delete',
    'project.create', 'project.delete', 'members.manage', 'workspace.statuses'
  ],
  true, true, 100
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The acting user's rank, once, so every rule below reads the same number.
-- ---------------------------------------------------------------------------
create or replace function public.actor_rank()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.rank
       from public.profiles p
       join public.roles r on r.id = p.role_id
      where p.id = auth.uid()),
    0);
$$;

revoke all on function public.actor_rank() from public;
grant execute on function public.actor_rank() to authenticated;

-- ---------------------------------------------------------------------------
-- Rules 1, 2 and 4 — on the roles table itself.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_role_rank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine integer := public.actor_rank();
  granted text;
begin
  -- The service role and Postgres itself run seeds and migrations; they have
  -- no `auth.uid()` and must not be caught by rules written for users.
  if auth.uid() is null then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  -- Rule 4 (INSERT) and Rule 2 (UPDATE/DELETE): never at or above yourself.
  if tg_op = 'INSERT' and new.rank >= mine then
    raise exception 'You cannot create a role at or above your own';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.rank >= mine then
    raise exception 'You cannot change a role at or above your own';
  end if;
  -- ...and you cannot lift a role you CAN edit up past yourself, which would
  -- be the same escalation taken in two steps.
  if tg_op = 'UPDATE' and new.rank >= mine then
    raise exception 'You cannot raise a role to or above your own';
  end if;

  -- Rule 1: no granting a permission you do not hold. Checked against what
  -- is actually being ADDED, so revoking is always allowed — an admin
  -- tidying up a role must not be blocked by a permission they lack.
  if tg_op in ('INSERT', 'UPDATE') then
    select p into granted
      from unnest(new.permissions) as p
     where not public.has_permission(p)
       and (tg_op = 'INSERT' or not (p = any (old.permissions)))
     limit 1;
    if granted is not null then
      raise exception 'You cannot grant "%" — your own role does not include it', granted;
    end if;
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

drop trigger if exists roles_enforce_rank on public.roles;
create trigger roles_enforce_rank
  before insert or update or delete on public.roles
  for each row execute function public.enforce_role_rank();

-- ---------------------------------------------------------------------------
-- Rule 3 — on profiles: no assigning a role above your own.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_assign_rank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_rank integer;
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.role_id is not distinct from old.role_id then
    return new;
  end if;
  select rank into target_rank from public.roles where id = new.role_id;
  if target_rank >= public.actor_rank() then
    raise exception 'You cannot assign a role at or above your own';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_assign_rank on public.profiles;
create trigger profiles_enforce_assign_rank
  before update on public.profiles
  for each row execute function public.enforce_assign_rank();

-- ---------------------------------------------------------------------------
-- The last-holder trigger, generalised.
--
-- `block_last_admin_removal` named the literal 'admin' three times, so an
-- Owner was invisible to it: a workspace could lose its only Owner while the
-- trigger contentedly protected a single Admin. It now keys on `roles.locked`
-- and counts holders of the ROLE BEING LEFT, so it protects the last Owner
-- and the last Admin alike without naming either.
--
-- The `supabase_auth_admin` carve-out is kept exactly as it was: GoTrue's
-- cascade delete from auth.users runs as that role, and without this a
-- workspace's last privileged account could never be deleted from the
-- dashboard at all.
-- ---------------------------------------------------------------------------
create or replace function public.block_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  was_locked boolean;
  peers integer;
begin
  if tg_op = 'DELETE' and session_user = 'supabase_auth_admin' then
    return old;
  end if;

  -- Keeping the same role, or moving INTO one: never a removal.
  if tg_op = 'UPDATE' and new.role_id is not distinct from old.role_id then
    return new;
  end if;

  select locked into was_locked from public.roles where id = old.role_id;
  if not coalesce(was_locked, false) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select count(*) into peers from public.profiles where role_id = old.role_id;
  if peers <= 1 then
    raise exception 'The last holder of the % role cannot be demoted or removed',
      (select name from public.roles where id = old.role_id);
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;
