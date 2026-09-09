-- Live updates: a table delivers change events only once it is in this
-- publication. Row-level security still applies to every subscriber; Task 1's
-- probe proves that rather than assuming it.
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.reactions;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.channels;
alter publication supabase_realtime add table public.activities;
alter publication supabase_realtime add table public.project_members;
alter publication supabase_realtime add table public.channel_members;
alter publication supabase_realtime add table public.task_collaborators;
alter publication supabase_realtime add table public.read_state;
alter publication supabase_realtime add table public.dms;
alter publication supabase_realtime add table public.dm_members;

-- Without this a DELETE arrives carrying only the primary key, and a row
-- removed from a join table cannot be matched to what the client holds.
alter table public.messages replica identity full;
alter table public.reactions replica identity full;
alter table public.tasks replica identity full;
alter table public.projects replica identity full;
alter table public.channels replica identity full;
alter table public.project_members replica identity full;
alter table public.channel_members replica identity full;
alter table public.task_collaborators replica identity full;
alter table public.read_state replica identity full;
alter table public.dm_members replica identity full;
