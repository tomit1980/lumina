-- Fixes seven RLS holes in 20260906000200_conversations.sql. That migration
-- was written faithfully from a brief whose SQL was the defect; this
-- migration does not touch it (already applied) and instead drops and
-- recreates only the broken policies.
--
-- Two root causes produced all seven holes:
--   (1) `for all` policies combine (OR) with the neighbouring read policy
--       (Postgres ORs multiple permissive policies together), so a `for
--       all ... using (<global permission>)` policy silently grants select
--       too, overriding a narrower read policy sitting right beside it.
--   (2) several `with check` clauses tested a global permission
--       (`has_permission(...)`) instead of the specific row being written,
--       letting a user attach themselves to a resource — a membership row
--       — which `can_see_conversation()` then trusted, escalating them
--       into private data.
--
-- The fix in each case: split `for all` into explicit insert/update/delete
-- (select is governed solely by the *_read policy), and scope every
-- `with check` to the specific row, using `channelIsManageable`
-- (lib/store.tsx:207) as the bar wherever a policy governs channel
-- management: the channel is not the team channel, and the actor either
-- holds channel.delete or is that channel's own creator.

-- SECURITY DEFINER, same reasoning as can_see_conversation above: a policy
-- on one table (channel_members, conversations) that inlines a subquery
-- against a DIFFERENT RLS-protected table (channels) would have that
-- subquery filtered by channels_read for the *acting* user. For the
-- legitimate bootstrap case — the creator of a brand-new private channel,
-- who is not yet its own channel_members row and so cannot yet satisfy
-- can_see_conversation() — that subquery would come back empty even for
-- the rightful creator, breaking bootstrap. Centralising the check here,
-- SECURITY DEFINER, reads the true row regardless of the caller's own
-- read access.
create or replace function public.channel_is_manageable(target_channel_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.channels c
    where c.id = target_channel_id
      and c.is_team = false
      and (public.has_permission('channel.delete') or c.created_by = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------
-- Hole 7: channels_insert never enforced created_by = auth.uid(), so a
-- channel could be created under someone else's identity. Fixed first: the
-- channel_members bootstrap clause further down trusts created_by, and
-- that trust only holds once this is closed.
-- ---------------------------------------------------------------------
drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels
  for insert to authenticated
  with check (
    public.has_permission('channel.create')
    and created_by = auth.uid()
  );

-- ---------------------------------------------------------------------
-- Hole 4: channels_update required only channel.create (which every
-- Member holds) instead of mirroring channelIsManageable, so any member
-- could rename or re-privatise a channel they could merely see.
-- ---------------------------------------------------------------------
drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels
  for update to authenticated
  using (
    is_team = false
    and (public.has_permission('channel.delete') or created_by = auth.uid())
  )
  with check (
    is_team = false
    and (public.has_permission('channel.delete') or created_by = auth.uid())
  );

-- ---------------------------------------------------------------------
-- Hole 3: conversations_write was `for all`, so its using clause (a global
-- permission check satisfied by nearly every authenticated user) also
-- governed select, overriding the narrower conversations_read policy and
-- exposing conversation rows for channels the user cannot see. Split into
-- insert/delete. No update path exists (kind is immutable once set), so no
-- update policy is defined and updates default-deny.
-- ---------------------------------------------------------------------
drop policy if exists conversations_write on public.conversations;
drop policy if exists conversations_insert on public.conversations;
drop policy if exists conversations_delete on public.conversations;

create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (
    public.has_permission('channel.create') or public.has_permission('message.send')
  );

-- Mirrors channelIsManageable, joined onto the specific conversation row so
-- a channel's parent row can be deleted the same way its child row can.
create policy conversations_delete on public.conversations
  for delete to authenticated
  using (public.channel_is_manageable(conversations.id));

-- ---------------------------------------------------------------------
-- Holes 1 & 2: channel_members_write was `for all` with a with check that
-- tested only the global channel.create permission (which every Member
-- holds), not the specific channel row. That meant (1) its using clause
-- leaked select, letting any member enumerate a private channel's
-- membership, and (2) its with check let a member insert themselves into
-- a private channel they don't belong to, which can_see_conversation()
-- then trusted — escalating them into reading it and all its messages.
-- Fixed by scoping every check to the specific channel row via
-- channelIsManageable's bar (not the team channel, and either
-- channel.delete or you are that channel's creator — now trustworthy
-- per hole 7's fix). This also preserves the bootstrap case: the
-- creator of a brand-new channel can add themselves as its first member.
-- ---------------------------------------------------------------------
drop policy if exists channel_members_write on public.channel_members;
drop policy if exists channel_members_insert on public.channel_members;
drop policy if exists channel_members_update on public.channel_members;
drop policy if exists channel_members_delete on public.channel_members;

create policy channel_members_insert on public.channel_members
  for insert to authenticated
  with check (public.channel_is_manageable(channel_members.channel_id));

create policy channel_members_update on public.channel_members
  for update to authenticated
  using (public.channel_is_manageable(channel_members.channel_id))
  with check (public.channel_is_manageable(channel_members.channel_id));

create policy channel_members_delete on public.channel_members
  for delete to authenticated
  using (public.channel_is_manageable(channel_members.channel_id));

-- ---------------------------------------------------------------------
-- Hole 5: dm_members_insert required only message.send, letting anyone
-- holding that permission (nearly every user) insert themselves as a
-- third member of someone else's two-person DM. The fix is NOT "you may
-- add yourself" — that is precisely the attack. You may create a
-- brand-new, memberless DM, or complete one you already belong to that
-- is not yet full.
--
-- The membership existence/count check below is wrapped in a SECURITY
-- DEFINER function rather than inlined directly in the policy. Inlined,
-- it would recurse into dm_members_read: a subquery against dm_members
-- run as the *acting* (attacking) user is itself filtered by that read
-- policy, which the attacker fails, so the subquery sees zero existing
-- members no matter how many really exist — always satisfying the
-- "brand-new DM" branch and defeating the check. Same reasoning as
-- can_see_conversation above: without SECURITY DEFINER, a policy that
-- queries its own table recurses into itself.
-- ---------------------------------------------------------------------
create or replace function public.can_join_dm(target_dm_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- creating a brand-new DM: it has no members yet
    not exists (select 1 from public.dm_members m where m.dm_id = target_dm_id)
    -- or completing a DM you already belong to, which is not yet full
    or (
      exists (select 1 from public.dm_members m
               where m.dm_id = target_dm_id and m.user_id = auth.uid())
      and (select count(*) from public.dm_members m where m.dm_id = target_dm_id) < 2
    );
$$;

drop policy if exists dm_members_insert on public.dm_members;
create policy dm_members_insert on public.dm_members
  for insert to authenticated
  with check (
    public.has_permission('message.send')
    and public.can_join_dm(dm_members.dm_id)
  );

-- ---------------------------------------------------------------------
-- Hole 6: reactions_write was `for all` and checked only user_id =
-- auth.uid(), never whether the reacting user could see the message's
-- conversation at all — an oracle confirming a message exists in a
-- channel you cannot read. Mirrors toggleReaction (lib/store.tsx:695),
-- which gates on canSeeConversation and nothing else.
-- ---------------------------------------------------------------------
drop policy if exists reactions_write on public.reactions;
drop policy if exists reactions_insert on public.reactions;
drop policy if exists reactions_delete on public.reactions;

create policy reactions_insert on public.reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = reactions.message_id
        and public.can_see_conversation(m.conversation_id)
    )
  );

create policy reactions_delete on public.reactions
  for delete to authenticated
  using (user_id = auth.uid());
