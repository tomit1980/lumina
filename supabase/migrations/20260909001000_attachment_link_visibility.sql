-- ---------------------------------------------------------------------
-- Linking a file now requires being allowed to SEE it.
--
-- Closes findings 1, 2 and 4 of
-- .superpowers/sdd/2026-09-08-store-swap/final-review.md, which were
-- demonstrated live against lumina-dev before this migration existed.
--
-- THE HOLE. The three `*_attachments_insert` policies checked only the
-- DESTINATION of a link and never the attachment being linked:
--
--   message_attachments_insert  -- you authored the message, and can still
--                                  see its conversation
--   project_attachments_insert  -- project_is_manageable(<target>)
--   task_attachments_insert     -- task.edit + the task's project is
--                                  visible and not viewer-only
--
-- `can_see_attachment` then TRUSTS whatever links exist. So anyone holding
-- `message.send` -- the only permission the shipped **Guest** role holds --
-- could take a known attachment id, insert a row linking it to a message of
-- their own (a public channel post, or a DM with themselves as author that
-- no third party ever reads), and the read policy would answer "yes, you can
-- see this attachment, it is on a message you can see". Since Task 10's
-- `attachment_objects_read` (20260910001000_storage.sql) is exactly
-- `can_see_attachment(...)`, that laundered visibility reached the BYTES in a
-- private bucket: the attachments row, a signed URL, and the file itself.
--
-- The prerequisite is only knowing the id, and ids are not secret to anyone
-- who ever had access -- `hydrate()` hands every project member the full
-- attachments row for every file they can see. So this was also a REVOCATION
-- hole: a member removed from a project kept the ids and could re-grant
-- themselves the bytes at will, which is precisely what
-- tests/rls/storage.test.ts:157 ("access lost is bytes lost") claimed could
-- not happen -- true, until now, only of the direct path it tested.
--
-- Pre-existing in the Plan 1 schema but INERT until Task 10 connected it to
-- real bytes, so it is this branch's to close.
--
-- THE FIX. AND `public.can_see_attachment(<table>.attachment_id)` into the
-- `with check` of all three insert policies: you may link a file only if you
-- may already see it. Nothing about the destination halves changes -- they
-- were right, they were just half the rule.
--
-- WHY THE EXISTING HELPER IS REUSED RATHER THAN A FOURTH COPY WRITTEN.
-- `can_see_attachment` is the function every read path already asks
-- (attachments_read, and all four storage.objects policies). Task 6 was burned
-- by a rule that existed twice and diverged; a fourth copy here would be the
-- same mistake. Reuse also makes the property exact rather than approximate:
-- "may link" is *the same question* as "may read", by construction.
--
-- AND IT DOES NOT RECURSE, for two independent reasons, both checked rather
-- than assumed:
--
--   1. `can_see_attachment` is SECURITY DEFINER and its owner is the table
--      owner, so its reads of project_attachments / task_attachments /
--      message_attachments are not subject to row-level security at all.
--      There is no policy evaluation inside it to re-enter. (That property
--      is load-bearing for its correctness anyway -- see the SECURITY
--      DEFINER note in 20260906000400_attachments.sql -- so it is not a
--      convenience being leaned on here for the first time.)
--   2. Even without that, a WITH CHECK for INSERT is evaluated BEFORE the
--      tuple is inserted, and the function is STABLE, so it reads the
--      statement's own snapshot. The row being authorised cannot authorise
--      itself, and neither can a sibling row of the same multi-row insert.
--
-- WHAT THIS DOES NOT BREAK, and why. Every legitimate link in the app is
-- made by someone who can already see the file:
--   * a fresh upload -- the row is written first with `uploaded_by =
--     auth.uid()` (attachments_insert leaves no other option), so
--     `can_see_attachment`'s unlinked-uploader branch is true at the moment
--     the first link is inserted;
--   * a project file shared into a message -- the sender can see the project,
--     so the project branch is true;
--   * updateProject / updateTask -- `syncAttachmentLinks`
--     (lib/backend/supabase/storage.ts) inserts links only for files the
--     patch ADDED and deletes removed ones outright. It never deletes and
--     re-inserts the same link, so no file passes through an unlinked state
--     in which a non-uploader would lose sight of it mid-write.
--
-- TABLE-QUALIFIED, deliberately. Inside the `exists (...)` subqueries below a
-- bare `attachment_id` or `message_id` would bind to the SUBQUERY's own
-- relation, and the predicate would be trivially true -- the exact defect
-- 20260906000350_fix_project_policies.sql was written to fix. Every outer
-- column here names its table.
-- ---------------------------------------------------------------------

drop policy if exists message_attachments_insert on public.message_attachments;
create policy message_attachments_insert on public.message_attachments
  for insert to authenticated
  with check (
    public.can_see_attachment(message_attachments.attachment_id)
    and exists (select 1 from public.messages m
                 where m.id = message_attachments.message_id
                   and m.author_id = auth.uid()
                   and public.can_see_conversation(m.conversation_id))
  );

drop policy if exists project_attachments_insert on public.project_attachments;
create policy project_attachments_insert on public.project_attachments
  for insert to authenticated
  with check (
    public.can_see_attachment(project_attachments.attachment_id)
    and public.project_is_manageable(project_attachments.project_id)
  );

drop policy if exists task_attachments_insert on public.task_attachments;
create policy task_attachments_insert on public.task_attachments
  for insert to authenticated
  with check (
    public.can_see_attachment(task_attachments.attachment_id)
    and public.has_permission('task.edit')
    and exists (select 1 from public.tasks t
                 where t.id = task_attachments.task_id
                   and public.can_see_project(t.project_id)
                   and not public.project_is_viewer_only(t.project_id))
  );

-- The UPDATE policies beside these are left exactly as they are. There is no
-- column on any of the three join tables worth updating (message_attachments'
-- `source_project_id` is the only one, and nothing writes it after insert),
-- and an UPDATE cannot introduce a link that an INSERT could not: the row it
-- would have to start from is one the caller can already see. Splitting the
-- rule across four policies to say that twice would be the divergence this
-- migration exists to avoid. No `for all` is introduced anywhere here.

-- ---------------------------------------------------------------------
-- Finding 4 -- deleting a project or task strands its file bytes.
--
-- DECISION: SWEEP, NOT CASCADE. Recorded here because the reasoning is
-- about the schema and belongs next to it.
--
-- The facts. `attachments` has no foreign key to `projects` or `tasks`; only
-- the JOIN rows do. So `delete from projects` cascades
-- `project_attachments` away and leaves the `attachments` row behind,
-- unlinked -- at which point `can_see_attachment`'s uploader branch makes it
-- visible to its uploader again and to nobody else. Visibility NARROWS, so
-- this is not a leak; it is unbounded storage cost, and the wide version of
-- the "unlinked orphans accumulate" item this plan already carries (which
-- until now described only a cancelled file-picker dialog).
--
-- WHAT WOULD HAPPEN TO THE OBJECTS UNDER A CASCADE, explicitly: nothing.
-- Bytes live in Storage, not in Postgres. A row cascade -- an FK, or a
-- trigger that deletes the `attachments` row when its last link goes --
-- removes the row and leaves the object in the bucket exactly where it was.
-- It would in fact make things strictly WORSE, and that is the whole reason
-- this migration adds no cascade:
--
--   * `attachment_objects_delete` (20260910001000_storage.sql) is answered
--     FROM the attachments row -- `is_attachment_uploader(...)` is false for
--     a row that no longer exists. Delete the row and the object becomes
--     permanently undeletable by every authenticated client, reachable only
--     by the service role. That is the precise trap the ORDERING note in
--     that migration exists to warn about (bytes first, row second), and a
--     cascade would build it into the schema.
--   * A cascade also cannot be scoped to "the project is being deleted": the
--     same trigger would fire when a user merely removes a file from a
--     project, and `syncAttachmentLinks` already handles that case correctly
--     and deliberately (bytes AND row, in that order).
--
-- So the rows deliberately SURVIVE, still carrying `storage_path` -- which is
-- the only durable pointer to the object. Sweeping is then a two-step the
-- service role can perform in the one order that works: remove the object,
-- then remove the row. `scripts/sweep-orphaned-attachments.mjs` does exactly
-- that and reuses the function below, so the definition of "orphaned" is not
-- re-derived in JavaScript.
--
-- Restricted to the service role: this reads across every attachment in the
-- database, which is not a question any signed-in user is entitled to ask.
-- ---------------------------------------------------------------------
create or replace function public.orphaned_attachments(older_than interval default interval '24 hours')
returns table (id text, storage_path text, name text, uploaded_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.storage_path, a.name, a.uploaded_at
  from public.attachments a
  where a.uploaded_at < now() - orphaned_attachments.older_than
    and not exists (select 1 from public.project_attachments pa where pa.attachment_id = a.id)
    and not exists (select 1 from public.task_attachments    ta where ta.attachment_id = a.id)
    and not exists (select 1 from public.message_attachments ma where ma.attachment_id = a.id)
  order by a.uploaded_at;
$$;

-- Default EXECUTE on a function is granted to PUBLIC, so revoking has to be
-- explicit -- the grant below is not what makes this service-role-only, the
-- revoke is.
revoke execute on function public.orphaned_attachments(interval) from public, anon, authenticated;
grant execute on function public.orphaned_attachments(interval) to service_role;
