-- Task 2 of the store-swap plan: the database pieces Plan 1 did not need.
--
-- Plan 1 built the schema a *logged-in* user operates on. It never built the
-- step that makes someone logged-in at all: a new row in auth.users is nobody
-- to this app until a public.profiles row exists for it, and to date the only
-- thing that ever created one was a test helper. Everything below hangs off
-- closing that gap, plus the four server-side operations the store is about to
-- stop doing on the client (DM find-or-create, task position, reaction toggle)
-- and the one column Task 3's admin 2FA policy needs.
--
-- Every rule Plan 1's probes established the hard way is followed here, and
-- each was a real hole when it was missing:
--   1. no `for all` — permissive policies OR together, so a `for all` USING
--      clause silently governs select too;
--   2. WITH CHECK scoped to the specific row, never a global permission;
--   3. policy/trigger helper functions are `security definer` with
--      `set search_path = public`, or they recurse or evaluate under the
--      attacker's own visibility;
--   4. every outer column reference inside a subquery is qualified — a bare
--      `id` binds to the subquery's own column and the predicate is always
--      true. Function parameters that share a name with a real column are
--      referenced as `<function_name>.<param>` for the same reason.
-- Column freezes and cross-row rules are triggers, not policies: a policy
-- cannot compare NEW to OLD.


-- =====================================================================
-- 1. Structure-only seed.
--
-- The user's binding decision for this plan is STRUCTURE ONLY: roles and a
-- team channel, and no fictional people, tasks or messages. lib/seed.ts's
-- demo cast stays a local-backend fixture and never reaches Postgres.
-- =====================================================================

-- The three system roles already exist on lumina-dev (verified: roles holds
-- exactly admin/member/guest, all is_system). `on conflict do nothing` rather
-- than an upsert is the "verify rather than duplicate" the brief asks for, and
-- it is also the only safe choice: an admin may have edited Member's or
-- Guest's permission set through the app, and an upsert here would silently
-- revert their configuration on every deploy. On a database that already has
-- them this statement is a no-op; on a fresh one it makes handle_new_user's
-- `role_id = 'member'` reference satisfiable.
--
-- Content mirrors DEFAULT_ROLES in lib/permissions.ts. tests/helpers/workspace.ts's
-- seedRoles() upserts from that same constant, so the suite is what keeps the
-- two from drifting.
insert into public.roles (id, name, description, color, permissions, is_system, locked)
values
  ('admin', 'Admin',
   'Full access — manage members, roles, and permissions.',
   '#8b5cf6',
   array['message.send','channel.create','channel.delete','message.deleteAny',
         'task.create','task.edit','task.move','task.delete',
         'project.create','project.delete','members.manage'],
   true, true),
  ('member', 'Member',
   'Day-to-day access: chat, create channels, and work with tasks.',
   '#0ea5e9',
   array['message.send','channel.create','task.create','task.edit','task.move'],
   true, false),
  ('guest', 'Guest',
   'Chat in public channels. Boards are view-only.',
   '#71717a',
   array['message.send'],
   true, false)
on conflict (id) do nothing;

-- handle_new_user below hard-depends on 'member' existing (profiles.role_id
-- carries `references roles (id) on delete restrict`, so a missing row would
-- make every single sign-up fail with a foreign-key violation). Fail the
-- migration here, loudly, rather than discovering it at the first sign-in.
-- roles_block_delete_with_members (20260906000500_invariants.sql) is what
-- keeps it true afterwards: a built-in role can never be deleted.
do $$
declare
  v_missing text;
begin
  select string_agg(want.id, ', ')
    into v_missing
    from (values ('admin'), ('member'), ('guest')) as want(id)
   where not exists (select 1 from public.roles r where r.id = want.id);
  if v_missing is not null then
    raise exception 'System roles missing after seed: %', v_missing;
  end if;
end $$;

-- Exactly one team channel, structurally. The index is partial on `is_team`,
-- so ordinary channels are not indexed at all and only a *second* team channel
-- conflicts (every indexed row carries the same value, true). Verified against
-- lumina-dev first: it currently has zero is_team channels, so this index
-- builds cleanly.
create unique index if not exists channels_single_team_idx
  on public.channels (is_team) where is_team;

-- The team channel itself. Guarded on "any team channel exists" rather than
-- on the id, so a deployment that already named its team channel something
-- else is left alone instead of gaining a second one (which the index above
-- would refuse anyway). created_by is null deliberately: this channel predates
-- every member, and channels.created_by is nullable for exactly that reason.
do $$
begin
  if exists (select 1 from public.channels c where c.is_team) then
    return;
  end if;
  insert into public.conversations (id, kind)
  values ('c_general', 'channel')
  on conflict (id) do nothing;
  insert into public.channels (id, name, description, is_private, is_team, created_by)
  values ('c_general', 'general',
          'Everyone on the team — announcements and general chatter',
          false, true, null)
  on conflict (id) do nothing;
end $$;


-- =====================================================================
-- 2. handle_new_user — a profile for every auth user.
--
-- THE gap this task exists to close. Supabase's GoTrue writes auth.users;
-- nothing in Plan 1 ever wrote public.profiles except tests/helpers/supabase.ts.
-- Without this trigger an admin can create a teammate in the dashboard, that
-- teammate can sign in, and then every policy in the schema evaluates
-- has_permission() against a profiles row that does not exist — they are
-- authenticated and simultaneously nobody.
--
-- SECURITY DEFINER: it runs inside GoTrue's own transaction under
-- supabase_auth_admin, which has no rights on public.profiles at all, and the
-- insert must not be filtered by profiles' RLS. Owned by postgres, which owns
-- profiles, so the owner's RLS exemption applies (no table here uses FORCE ROW
-- LEVEL SECURITY).
--
-- Idempotent with respect to tests/helpers/supabase.ts's createTestUser, which
-- inserts the profile itself immediately after the admin API returns: the
-- helper already uses .upsert() keyed on the primary key, so it now updates
-- the row this trigger just created instead of creating it, and the fixture's
-- chosen name/handle/role still win. The `on conflict (id) do nothing` below
-- covers the other direction (a re-fired trigger, or a profile somehow already
-- present).
--
-- HANDLE COLLISIONS. profiles.handle is `unique not null`, and two people can
-- easily share an email local part across domains (jane@acme.com,
-- jane@contractor.io). Strategy, in order:
--   * base = the local part lowercased with everything outside [a-z0-9]
--     stripped, truncated to 24 chars; 'member' if that leaves nothing.
--   * scan for the first free base, base2, base3 ... up to base50.
--   * past that (or if the scan loses a race with a concurrent sign-up)
--     fall back to base truncated to 16 chars + the first 8 hex characters of
--     the new user's own uuid, which is unique by construction and needs no
--     scan at all.
-- The scan is racy on its own — two simultaneous sign-ups can both pick
-- `jane2` — which is precisely why the insert is wrapped: a unique_violation
-- retries once on the uuid-suffixed handle, which cannot collide.
--
-- A null email (a phone-only auth user) gets a placeholder address on the
-- reserved .invalid TLD rather than being skipped. profiles.email is
-- `not null`, and the invariant this trigger exists to establish is "every
-- auth user is somebody" — silently skipping would reintroduce the exact gap.
-- Unreachable in this deployment: public sign-ups are off and the dashboard
-- flow in docs/runbooks/creating-a-user.md always supplies an email.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text;
  v_local  text;
  v_base   text;
  v_handle text;
  v_name   text;
  v_uniq   text;
  v_n      integer := 1;
begin
  v_email := coalesce(new.email, new.id::text || '@placeholder.invalid');
  v_local := nullif(btrim(split_part(v_email, '@', 1)), '');

  -- Display name: separators become spaces, then title case. "jane.doe" reads
  -- as "Jane Doe" in the member list on day one, which an admin can edit.
  v_name := initcap(regexp_replace(coalesce(v_local, 'New member'), '[._+-]+', ' ', 'g'));
  if btrim(v_name) = '' then
    v_name := 'New member';
  end if;

  v_base := left(lower(regexp_replace(coalesce(v_local, ''), '[^a-zA-Z0-9]+', '', 'g')), 24);
  if v_base = '' then
    v_base := 'member';
  end if;
  v_uniq := left(v_base, 16) || substr(replace(new.id::text, '-', ''), 1, 8);

  v_handle := v_base;
  while v_n < 50 and exists (select 1 from public.profiles p where p.handle = v_handle) loop
    v_n := v_n + 1;
    v_handle := v_base || v_n::text;
  end loop;
  if exists (select 1 from public.profiles p where p.handle = v_handle) then
    v_handle := v_uniq;
  end if;

  begin
    insert into public.profiles (id, email, name, handle, role_id)
    values (new.id, v_email, v_name, v_handle, 'member')
    on conflict (id) do nothing;
  exception when unique_violation then
    -- The handle was taken between the scan and the insert. v_uniq embeds this
    -- user's own uuid, so the retry cannot lose the same race twice. An email
    -- collision would still raise from here, which is correct: auth.users
    -- already enforces unique emails, so it would mean a genuinely corrupt
    -- profiles row and must not be papered over.
    insert into public.profiles (id, email, name, handle, role_id)
    values (new.id, v_email, v_name, v_uniq, 'member')
    on conflict (id) do nothing;
  end;

  return new;
end;
$$;

-- supabase_auth_admin is the role GoTrue runs as, and it is not a superuser:
-- it needs to reach the function to fire the trigger at all. The function is
-- SECURITY DEFINER, so this grants the ability to invoke it, not any access to
-- public.profiles itself.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- 3. DM uniqueness + find_or_create_dm.
--
-- The member pair does NOT live on the dms row — it lives in the dm_members
-- join table (20260906000200_conversations.sql), so "a unique index on the
-- ordered pair" cannot be written against dms as it stands and cannot be
-- written against dm_members at all (a unique index is per row; the pair is
-- two rows). The shape that works: a derived `pair_key` column on dms, kept in
-- lockstep with dm_members by a trigger, with the uniqueness enforced on that
-- column. dm_members stays the single source of truth; pair_key is a
-- projection of it that the index can actually see.
-- =====================================================================

alter table public.dms add column if not exists pair_key text;

-- `least`/`greatest` on uuid give the ordered pair, so the key is the same
-- whichever of the two people opens the thread first. IMMUTABLE: it is a pure
-- function of its arguments and is used from a trigger and an RPC.
create or replace function public.dm_pair_key(a uuid, b uuid)
returns text
language sql
immutable
as $$
  select least(a, b)::text || ':' || greatest(a, b)::text;
$$;

-- Backfill before the index, or an existing duplicate pair would surface as a
-- confusing index-build failure instead of the data problem it is. lumina-dev
-- currently has zero dms rows; this is here for any other database.
--
-- `array_agg(... order by user_id)` rather than min()/max(): Postgres has no
-- min/max aggregate for uuid at all, and aggregating over user_id::text
-- instead would compare under the database collation while dm_pair_key's
-- least/greatest compare as uuids. Ordering the aggregate by the uuid column
-- keeps both sides on the one comparison.
update public.dms d
   set pair_key = pairs.key
  from (
    select grouped.dm_id,
           public.dm_pair_key(grouped.members[1], grouped.members[2]) as key
      from (
        select m.dm_id, array_agg(m.user_id order by m.user_id) as members
          from public.dm_members m
         group by m.dm_id
        having count(*) = 2
      ) grouped
  ) pairs
 where d.id = pairs.dm_id
   and d.pair_key is distinct from pairs.key;

-- NULLs are distinct in a unique index, so a half-built DM (one member, or a
-- DM whose other member's account was deleted) never conflicts — only two
-- fully-formed DMs between the same two people do. THIS is what makes two
-- racing clients impossible to satisfy: the loser gets a 23505 and rolls back,
-- no matter what the RPC below does or does not do.
create unique index if not exists dms_pair_key_idx
  on public.dms (pair_key) where pair_key is not null;

-- pair_key is derived state and must never be client-supplied. dms_insert
-- (20260906000200) lets any holder of message.send insert a dms row, so
-- without this a user could squat the key of two *other* people's pair and
-- permanently wedge their DM — find_or_create_dm would then hand them a thread
-- neither is a member of. There is deliberately no UPDATE policy on dms at
-- all, so INSERT is the only path a client has and this is the only guard
-- needed; sync_dm_pair_key below writes the column from a SECURITY DEFINER
-- trigger, which is not subject to that missing policy.
create or replace function public.clear_dm_pair_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.pair_key := null;
  return new;
end;
$$;

drop trigger if exists dms_clear_pair_key on public.dms;
create trigger dms_clear_pair_key
  before insert on public.dms
  for each row execute function public.clear_dm_pair_key();

-- AFTER, not BEFORE, and on dm_members rather than dms: the value is a
-- function of the *other* table's rows, and it can only be computed once they
-- are actually there. Fires per row, but both invocations of a two-row insert
-- run at end of statement and see the same final membership, so the second is
-- a no-op thanks to the `is distinct from` guard.
--
-- SECURITY DEFINER: it reads dm_members and writes dms, both RLS-protected,
-- and under the caller's own visibility the membership count would be filtered
-- by dm_members_read and come back wrong.
--
-- Safe under every cascade: deleting a dms row cascades into dm_members after
-- the parent is gone, so the UPDATE below matches zero rows; deleting a
-- profile cascades into dm_members and correctly drops the pair back to NULL,
-- freeing the key.
create or replace function public.sync_dm_pair_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dm      text := coalesce(new.dm_id, old.dm_id);
  v_members uuid[];
  v_key     text;
begin
  -- Ordered array_agg, not min()/max(): there is no min/max aggregate for uuid
  -- in Postgres, and ordering by the uuid column keeps this on the same
  -- comparison dm_pair_key's least/greatest use.
  select array_agg(m.user_id order by m.user_id)
    into v_members
    from public.dm_members m
   where m.dm_id = v_dm;

  if coalesce(array_length(v_members, 1), 0) = 2 then
    v_key := public.dm_pair_key(v_members[1], v_members[2]);
  else
    v_key := null;
  end if;

  update public.dms d
     set pair_key = v_key
   where d.id = v_dm
     and d.pair_key is distinct from v_key;

  return null;
end;
$$;

drop trigger if exists dm_members_sync_pair_key on public.dm_members;
create trigger dm_members_sync_pair_key
  after insert or delete on public.dm_members
  for each row execute function public.sync_dm_pair_key();

-- Retires the client-side find-then-create in sendToUser/openDm
-- (lib/store.tsx), which reads the DM list, finds nothing, and creates one —
-- two round trips with a window between them that two tabs of the same app can
-- both walk through.
--
-- SECURITY DEFINER (per the brief) — which means RLS is OFF inside, and every
-- check the policies would have applied has to be made explicitly here.
-- That is what the four guards below are: authenticated (dms_insert /
-- dm_members_insert are `to authenticated`), message.send (both policies
-- require it), the target must be someone the caller can actually see, and not
-- yourself. can_see_profile is the mirror of profiles_read; see its comment.
--
-- Race safety does not rest on the SELECT below — it rests on
-- dms_pair_key_idx. Two callers can both find nothing and both proceed; the
-- second one's dm_members insert fires sync_dm_pair_key, which raises 23505,
-- and the handler re-reads the winner's row. In READ COMMITTED the failed
-- subtransaction rolls back and the retry gets a fresh command snapshot, so
-- the winner's committed row is visible by then.
create or replace function public.can_see_profile(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Mirrors profiles_read (20260906000100_identity.sql):
  -- `for select to authenticated using (true)` — the auth.uid() test is the
  -- `to authenticated` half, the exists is the row half. If profiles_read is
  -- ever narrowed, this must be narrowed with it or find_or_create_dm becomes
  -- a directory oracle.
  select auth.uid() is not null
     and exists (select 1 from public.profiles p
                  where p.id = can_see_profile.target_user_id);
$$;

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
-- 4. Task position default.
--
-- Retires the client-side `columnSize` count in createTask (lib/store.tsx):
-- two clients adding a card to the same column both read the same count and
-- both claim the same position.
--
-- "Not supplied" has to be distinguishable from "supplied as 0", and a BEFORE
-- INSERT trigger cannot tell them apart while the column defaults to 0 — an
-- explicit `position: 0` (insert at the head of a column) is a real value the
-- trigger must not steal. So the default becomes a sentinel the trigger
-- replaces, and the column keeps both NOT NULL and a default:
--
--   * NOT NULL keeps `position` non-nullable in the generated Row type, and
--     BEFORE ROW triggers run before the NOT NULL check, so an insert that
--     passes an explicit NULL is treated as "append" rather than rejected.
--   * a default keeps `position` OPTIONAL in the generated Insert type, which
--     is the entire point — Task 5's client stops sending a position at all,
--     and tests/rls/attachments.test.ts already inserts a task without one.
--
-- The sentinel is -1 rather than NULL because `alter column ... set default
-- null` is NOT reported as a default by Supabase's type generator (measured:
-- with it, `position` came back REQUIRED in the generated Insert type, which
-- would force every caller to keep computing the value this trigger exists to
-- compute). -1 is never a legitimate position: positions are 0-based indices
-- into a column, so any negative value means "put it at the end".
-- =====================================================================

alter table public.tasks alter column position set default -1;

-- SECURITY DEFINER: max() must run over the whole column, not the caller's
-- filtered view of it. tasks_read would hide nothing from a caller who can
-- legitimately insert here today, but a max computed over a partially visible
-- column would silently hand out a duplicate position, and that is not a
-- property worth depending on RLS to preserve.
--
-- Two simultaneous inserts into the same column can still both read the same
-- max and land on the same position. That is a tie, not a corruption: every
-- read orders by (position, created_at) — see move_task in
-- 20260906000500_invariants.sql — so the two cards get a stable, sensible
-- order, and the first move_task on that column renumbers it cleanly. This is
-- strictly better than the client-side count it replaces, which had the same
-- tie plus a network round trip inside the window.
create or replace function public.set_task_position()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- NULL as well as the -1 default: an explicit NULL from a caller means the
  -- same thing ("I don't know, put it last"), and letting it through to the
  -- NOT NULL check instead would be a worse error than an obvious answer.
  -- max() ignores nothing here — every existing row is non-null by the same
  -- constraint.
  if new.position is null or new.position < 0 then
    select coalesce(max(t.position) + 1, 0)
      into new.position
      from public.tasks t
     where t.project_id = new.project_id
       and t.status = new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_default_position on public.tasks;
create trigger tasks_default_position
  before insert on public.tasks
  for each row execute function public.set_task_position();


-- =====================================================================
-- 5. toggle_reaction — add-or-remove in one statement.
--
-- SECURITY INVOKER, deliberately, and for the same reason move_task is
-- (20260906000500_invariants.sql): this is an RPC a client calls directly, and
-- the existing reactions policies already say exactly the right thing —
-- reactions_insert requires `user_id = auth.uid()` AND that the message's
-- conversation is visible; reactions_delete requires `user_id = auth.uid()`;
-- both are `to authenticated`. Running as the caller means those policies are
-- the enforcement, rather than a copy of them inside a definer function that
-- can drift from the originals. The message lookup below is likewise filtered
-- by messages_read, so a message in a channel the caller is not in reads as
-- absent and the function raises the same 'not found' an unknown id gets —
-- no oracle.
--
-- The toggle itself is ONE statement. The data-modifying CTEs share a single
-- snapshot, and `added` is forced to run after `removed` because it references
-- it, so the row can never be both deleted and re-inserted, or missed by both.
-- A read-then-write pair in two statements would let two rapid clicks both see
-- "not reacted" and both insert (a primary-key error) or both see "reacted"
-- and both delete.
--
-- Returns the resulting state so the client can reconcile its optimistic copy
-- against what actually happened rather than assuming its own guess held.
-- =====================================================================

create or replace function public.toggle_reaction(message_id text, emoji text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_conv  text;
  v_added boolean;
  v_users uuid[];
begin
  if v_me is null then
    raise exception 'You must be signed in to react';
  end if;

  select m.conversation_id
    into v_conv
    from public.messages m
   where m.id = toggle_reaction.message_id;
  if v_conv is null then
    raise exception 'Message % not found or not visible', toggle_reaction.message_id;
  end if;

  with removed as (
    delete from public.reactions r
     where r.message_id = toggle_reaction.message_id
       and r.emoji      = toggle_reaction.emoji
       and r.user_id    = v_me
    returning 1
  ),
  added as (
    insert into public.reactions (message_id, emoji, user_id)
    select toggle_reaction.message_id, toggle_reaction.emoji, v_me
     where not exists (select 1 from removed)
    returning 1
  )
  select exists (select 1 from added) into v_added;

  select coalesce(array_agg(r.user_id order by r.user_id), array[]::uuid[])
    into v_users
    from public.reactions r
   where r.message_id = toggle_reaction.message_id
     and r.emoji      = toggle_reaction.emoji;

  return jsonb_build_object(
    'message_id', toggle_reaction.message_id,
    'emoji',      toggle_reaction.emoji,
    'added',      v_added,
    'user_ids',   to_jsonb(v_users),
    'count',      coalesce(array_length(v_users, 1), 0)
  );
end;
$$;


-- =====================================================================
-- 6. profiles.mfa_required — the admin "require two-factor" switch Task 3
--    consumes.
-- =====================================================================

alter table public.profiles
  add column if not exists mfa_required boolean not null default false;

-- profiles already carries profiles_update_self
-- (`using (id = auth.uid()) with check (id = auth.uid())`,
-- 20260906000100_identity.sql), which lets every member update their own row —
-- and therefore, without this, clear the very requirement an admin just placed
-- on them. A policy cannot express the rule, because the rule is about NEW vs
-- OLD on one column, so this is a trigger: exactly the shape of
-- block_self_role_change (same file) and freeze_created_by
-- (20260906000350_fix_project_policies.sql).
--
-- The service-role bypass mirrors freeze_created_by's, with one difference:
-- `coalesce(auth.role(), '')`, not a bare comparison. `auth.role()` is NULL for
-- writes that arrive outside PostgREST, and `null <> 'service_role'` evaluates
-- to NULL, which a plpgsql `if` treats as false — so a bare comparison would
-- silently wave those writes through. Nothing reaches this trigger that way
-- today (the auth-user cascade is a DELETE and this is BEFORE UPDATE), but the
-- guard should not depend on that staying true.
--
-- An admin may set their own mfa_required; that is a member of members.manage
-- choosing to hold themselves to the policy, not an escalation.
create or replace function public.guard_mfa_required()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.mfa_required is distinct from old.mfa_required
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.has_permission('members.manage') then
    raise exception 'Only an admin can change the two-factor requirement';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_mfa_required on public.profiles;
create trigger profiles_guard_mfa_required
  before update on public.profiles
  for each row execute function public.guard_mfa_required();
