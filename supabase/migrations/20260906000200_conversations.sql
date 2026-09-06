create table public.conversations (
  id   text primary key,
  kind text not null check (kind in ('channel', 'dm'))
);

create table public.channels (
  id              text primary key references public.conversations (id) on delete cascade,
  name            text not null,
  description     text not null default '',
  is_private      boolean not null default false,
  is_team         boolean not null default false,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create table public.channel_members (
  channel_id text not null references public.channels (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  level      text not null default 'editor' check (level in ('viewer', 'editor')),
  primary key (channel_id, user_id)
);

create table public.dms (
  id         text primary key references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.dm_members (
  dm_id   text not null references public.dms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (dm_id, user_id)
);

create table public.messages (
  id              text primary key,
  conversation_id text not null references public.conversations (id) on delete cascade,
  author_id       uuid references public.profiles (id) on delete set null,
  content         text not null default '',
  created_at      timestamptz not null default now(),
  edited_at       timestamptz
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.reactions (
  message_id text not null references public.messages (id) on delete cascade,
  emoji      text not null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (message_id, emoji, user_id)
);

-- SECURITY DEFINER: called from policies on the very tables it reads.
-- Without this, channel_members' policy recurses into itself.
create or replace function public.can_see_conversation(conv_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.has_permission('members.manage') then true
      when exists (select 1 from public.channels c
                    where c.id = conv_id and c.is_private = false) then true
      when exists (select 1 from public.channel_members m
                    where m.channel_id = conv_id and m.user_id = auth.uid()) then true
      when exists (select 1 from public.dm_members d
                    where d.dm_id = conv_id and d.user_id = auth.uid()) then true
      else false
    end;
$$;

alter table public.conversations   enable row level security;
alter table public.channels        enable row level security;
alter table public.channel_members enable row level security;
alter table public.dms             enable row level security;
alter table public.dm_members      enable row level security;
alter table public.messages        enable row level security;
alter table public.reactions       enable row level security;

create policy conversations_read on public.conversations
  for select to authenticated using (public.can_see_conversation(id));

create policy channels_read on public.channels
  for select to authenticated using (public.can_see_conversation(id));

create policy channels_insert on public.channels
  for insert to authenticated with check (public.has_permission('channel.create'));

create policy channels_update on public.channels
  for update to authenticated
  using (public.can_see_conversation(id) and public.has_permission('channel.create'))
  with check (public.has_permission('channel.create'));

create policy channels_delete on public.channels
  for delete to authenticated
  using (public.has_permission('channel.delete') and is_team = false);

create policy conversations_write on public.conversations
  for all to authenticated
  using (public.has_permission('channel.create') or public.has_permission('message.send'))
  with check (public.has_permission('channel.create') or public.has_permission('message.send'));

create policy channel_members_read on public.channel_members
  for select to authenticated using (public.can_see_conversation(channel_id));

create policy channel_members_write on public.channel_members
  for all to authenticated
  using (public.has_permission('channel.create') or public.has_permission('members.manage'))
  with check (public.has_permission('channel.create') or public.has_permission('members.manage'));

create policy dms_read on public.dms
  for select to authenticated using (public.can_see_conversation(id));

create policy dms_insert on public.dms
  for insert to authenticated with check (public.has_permission('message.send'));

create policy dm_members_read on public.dm_members
  for select to authenticated using (public.can_see_conversation(dm_id));

create policy dm_members_insert on public.dm_members
  for insert to authenticated with check (public.has_permission('message.send'));

create policy messages_read on public.messages
  for select to authenticated using (public.can_see_conversation(conversation_id));

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.has_permission('message.send')
    and public.can_see_conversation(conversation_id)
  );

-- Mirrors lib/store.tsx:671 — you may only edit your own message.
create policy messages_update on public.messages
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- Mirrors canDeleteMessage, lib/store.tsx:1089.
create policy messages_delete on public.messages
  for delete to authenticated
  using (author_id = auth.uid() or public.has_permission('message.deleteAny'));

create policy reactions_read on public.reactions
  for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and public.can_see_conversation(m.conversation_id)));

create policy reactions_write on public.reactions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
