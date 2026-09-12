-- Three tables and one function that the assurance gate never covered.
--
-- 20260910004000 wrote its table list out by hand, and said why: "a table
-- added later should have to be considered, not silently swept in or silently
-- missed." The list has been wrong since the day it was written. Checked
-- against every `enable row level security` in this directory, twenty-two
-- tables exist and seventeen are named there. `task_sets` and
-- `task_set_items` were added later and did the right thing in their own
-- migration (20260911000200:164). The other three were never considered:
--
--   * `conversations`     — predates the gate. Missed.
--   * `message_attachments` — predates the gate. Missed.
--   * `statuses`          — added in the very next migration
--                           (20260910005000), one number after the rule it
--                           should have obeyed.
--
-- WHAT AN UNASSURED SESSION ACTUALLY GETS FROM THEM, stated plainly rather
-- than inflated, because the fix is cheap either way and the next person
-- deserves the real number. Not message bodies, not file bytes, not names —
-- `messages`, `attachments`, `profiles` and `storage.objects` are all inside
-- the gate and stay dark. What leaks is shape:
--
--   * `conversations` — the id and kind of every conversation the account
--     belongs to. An enumerable list of what exists.
--   * `message_attachments` — which attachment id hangs off which message,
--     for those same conversations. The join, not the file.
--   * `statuses` — the workspace's column names and colours. Read-only to
--     everyone by design (`statuses_read` is `using (true)`), so this is the
--     least of the three.
--
-- And one write. `conversations_insert` asks only for `channel.create` or
-- `message.send`, which every Member holds, so a half-signed-in session can
-- add a `conversations` row. Its `channels`/`dms` partner is gated, so what
-- it makes is an orphan — noise, not damage. It is still a write by a session
-- that has not finished signing in, and that is the thing the gate is for.
--
-- The severity here is "the invariant does not hold", not "the workspace is
-- open". QA-104 is intact; these are the corners it did not reach.

drop policy if exists require_assurance on public.conversations;
create policy require_assurance on public.conversations as restrictive to authenticated
  using (public.session_is_assured()) with check (public.session_is_assured());

drop policy if exists require_assurance on public.message_attachments;
create policy require_assurance on public.message_attachments as restrictive to authenticated
  using (public.session_is_assured()) with check (public.session_is_assured());

drop policy if exists require_assurance on public.statuses;
create policy require_assurance on public.statuses as restrictive to authenticated
  using (public.session_is_assured()) with check (public.session_is_assured());

-- =====================================================================
-- The hole a restrictive policy cannot close
-- =====================================================================
--
-- `find_or_create_dm` is SECURITY DEFINER, and RLS does not apply inside a
-- definer function. So every `require_assurance` policy above — and the
-- seventeen from 20260910004000 — is simply not consulted for the three
-- inserts it performs. An aal1 session can call it by RPC and come back with
-- a real DM: `conversations`, `dms` and two `dm_members` rows, all created
-- past a gate that was closed.
--
-- This is not a flaw in that function's own reasoning, which is careful about
-- everything it was written to be careful about — the signed-in check, the
-- permission, and the deliberate sameness of the two refusal messages so the
-- function is not a directory oracle. Assurance simply arrived two migrations
-- after it, and nothing went back.
--
-- It is the only one that needs this. `create_project_with_tasks` is SECURITY
-- INVOKER (20260911000200:255) and therefore already inside every policy;
-- every other definer function in this directory either returns `trigger` —
-- so it runs within a statement RLS has already judged — or is a read-only
-- predicate. `find_or_create_dm` is the single definer function that writes.
--
-- The check goes directly below the signed-in test, because that is what it
-- is: a second half of "are you actually signed in". Everything else in the
-- body is unchanged.
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
  -- policies cannot do this for us. See the header.
  if not public.session_is_assured() then
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
