-- Roles carry the permission set. Ids are text: the three system roles keep
-- their literal ids ('admin'/'member'/'guest'), custom roles use 'r_<uuid>'.
create table public.roles (
  id          text primary key,
  name        text not null,
  description text not null default '',
  color       text not null default '#64748b',
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  locked      boolean not null default false
);

-- One profile per auth user.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  name       text not null,
  handle     text not null unique,
  title      text not null default '',
  role_id    text not null references public.roles (id) on delete restrict,
  color      text not null default '#7c3aed',
  created_at timestamptz not null default now()
);

create index profiles_role_id_idx on public.profiles (role_id);

-- SECURITY DEFINER so policies on profiles can call it without recursing
-- into profiles' own RLS.
create or replace function public.my_role_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role_id from public.profiles where id = auth.uid();
$$;

create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select perm = any (r.permissions)
       from public.profiles p
       join public.roles r on r.id = p.role_id
      where p.id = auth.uid()),
    false);
$$;

alter table public.roles    enable row level security;
alter table public.profiles enable row level security;

-- One team: every signed-in member can read the directory.
create policy roles_read on public.roles
  for select to authenticated using (true);

create policy roles_write on public.roles
  for all to authenticated
  using (public.has_permission('members.manage'))
  with check (public.has_permission('members.manage'));

create policy profiles_read on public.profiles
  for select to authenticated using (true);

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_write on public.profiles
  for all to authenticated
  using (public.has_permission('members.manage'))
  with check (public.has_permission('members.manage'));

-- Mirrors lib/store.tsx:420 — nobody may change their own role, including admins.
create or replace function public.block_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role_id is distinct from old.role_id and old.id = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  return new;
end;
$$;

create trigger profiles_block_self_role_change
  before update on public.profiles
  for each row execute function public.block_self_role_change();
