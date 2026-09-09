-- Closes the last hole in QA-001. Task 4 narrowed hydration to the rows RLS
-- allows, but activities_read (20260906000400_attachments.sql) was still
-- `using (true)`: the table carried only free text and no reference to the
-- thing that text describes, so there was nothing to filter on. Every
-- signed-in browser therefore received rows like `created the Payroll
-- project` and `deleted #board-only`, naming restricted projects and private
-- channels to people who cannot see either. That was flagged as an accepted
-- limitation at the time (and asserted in tests/probes/attachment_probe.mjs so
-- a change would be noticed); with real data now loading, it isn't acceptable.
--
-- The fix is a nullable scope plus a policy that filters on it. Channels and
-- DMs share public.conversations (20260906000200_conversations.sql), so one
-- conversation_id column covers both, and public.can_see_conversation is the
-- helper that already decides visibility for either kind. Projects use
-- public.can_see_project. Both helpers are reused as-is rather than
-- reimplemented — the visibility rules (and their SECURITY DEFINER bypass of
-- the caller's own filtered view) live in exactly one place.

alter table public.activities
  add column project_id      text references public.projects (id)      on delete cascade,
  add column conversation_id text references public.conversations (id) on delete cascade;

-- DELETION SEMANTICS — deliberately CASCADE, not SET NULL.
--
-- SET NULL would promote a scoped row to workspace-wide at the exact moment
-- its resource is deleted, which republishes the name this migration exists to
-- hide: `deleted the Payroll project`, scoped and invisible one moment, becomes
-- visible to the whole workspace the next. That is the original leak with a
-- delay on it. CASCADE instead retires the activity with the resource it
-- names, so a name never outlives the access control that protected it.
--
-- The accepted cost: an activity scoped to a resource cannot outlive that
-- resource, so the `deleted the X project` / `deleted #X` lines are removed by
-- the same delete that creates them (and, once these writes actually reach
-- Postgres in tasks 5-8, an insert sequenced after the delete would fail the
-- foreign key outright). A durable record of who deleted what belongs in a
-- server-side audit log with its own access rules, not in a feed every user
-- reads. Privacy over feed completeness.

-- An activity names one thing. Both columns set would be ambiguous, and the
-- read policy's AND (below) would then demand visibility of both — harmless
-- but silently confusing. Forbid the state instead of relying on the policy to
-- cope with it.
alter table public.activities
  add constraint activities_single_scope
    check (project_id is null or conversation_id is null);

create index activities_project_idx      on public.activities (project_id);
create index activities_conversation_idx on public.activities (conversation_id);

-- Visible when the row names nothing (a workspace-wide event such as a role
-- change), or when every resource it does name is visible to the caller.
--
-- Written as an AND of two "null or visible" clauses rather than an OR of
-- positive cases: with both columns null it reduces to true, with one set it
-- reduces to that resource's own helper, and if the single-scope constraint
-- above were ever dropped, a two-scope row would require BOTH to be visible.
-- The OR form would have failed open in that last case, showing a row naming a
-- restricted project to anyone who could see the attached conversation.
--
-- Columns are table-qualified. A bare `project_id` inside a helper's own
-- subquery body binds to that subquery's column and the predicate silently
-- becomes always-true — the defect this schema has already been bitten by.
drop policy if exists activities_read on public.activities;
create policy activities_read on public.activities
  for select to authenticated
  using (
    (activities.project_id is null
      or public.can_see_project(activities.project_id))
    and (activities.conversation_id is null
      or public.can_see_conversation(activities.conversation_id))
  );

-- The scope is decorative unless writes are gated by the same rule. Without
-- this, any user could attach an activity to a project or conversation they
-- cannot see — writing into a feed they are not party to, and (since the read
-- policy trusts the scope) hiding a row from everyone who can see the
-- resource but not from themselves. Same predicate as the read policy, plus
-- the original actor binding.
--
-- Kept as separate per-command policies: no `for all` anywhere near this
-- table. Postgres ORs permissive policies together, so a `for all` USING
-- clause would silently grant SELECT alongside activities_read and undo the
-- filter above — the defect fixed in 20260906000350_fix_project_policies.sql.
-- There is deliberately still no UPDATE or DELETE policy: activities are
-- append-only to every authenticated caller, as before.
drop policy if exists activities_insert on public.activities;
create policy activities_insert on public.activities
  for insert to authenticated
  with check (
    activities.actor_id = auth.uid()
    and (activities.project_id is null
      or public.can_see_project(activities.project_id))
    and (activities.conversation_id is null
      or public.can_see_conversation(activities.conversation_id))
  );
