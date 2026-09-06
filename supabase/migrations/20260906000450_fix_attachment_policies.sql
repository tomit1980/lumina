-- Fixes three RLS findings from the review of task 7
-- (20260906000400_attachments.sql, commit 3c3d715). See
-- task-7-report.md's follow-up review for the full writeup; this
-- migration does not touch the applied file and instead redefines the
-- broken function/policies and adds a freeze trigger, following the same
-- shape as 20260906000250_fix_conversation_policies.sql and
-- 20260906000350_fix_project_policies.sql.

-- ---------------------------------------------------------------------
-- Finding 1 — CONFIRMED, High: can_see_attachment's uploader fallback
-- ("a freshly uploaded row is visible to its uploader before it is
-- linked") was unconditional -- `or exists (select 1 from
-- public.attachments a where a.id = att_id and a.uploaded_by =
-- auth.uid())` -- so it never stopped applying once the row *was*
-- linked. Confirmed live: a user removed from a restricted project's
-- membership kept reading their old attachment row via this branch
-- alone, including name and storage_path (which embeds the project id).
--
-- Fixed by scoping the fallback to genuinely unlinked attachments: it
-- now requires no row exists for att_id in any of
-- project_attachments/task_attachments/message_attachments. Once an
-- attachment is linked to anything, visibility comes solely from that
-- link's own can_see_project/can_see_conversation check above -- exactly
-- what the three `or exists` branches above the fallback already
-- provide. SECURITY DEFINER + search_path retained unchanged from
-- 20260906000400_attachments.sql's original definition, for the same
-- reason given there: this queries RLS-protected tables
-- (project_attachments/task_attachments/message_attachments/tasks/
-- messages/attachments) and must see the true rows, not the caller's own
-- filtered view of them.
-- ---------------------------------------------------------------------
create or replace function public.can_see_attachment(att_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.project_attachments pa
             where pa.attachment_id = att_id and public.can_see_project(pa.project_id))
    or exists (select 1 from public.task_attachments ta
                join public.tasks t on t.id = ta.task_id
               where ta.attachment_id = att_id and public.can_see_project(t.project_id))
    or exists (select 1 from public.message_attachments ma
                join public.messages m on m.id = ma.message_id
               where ma.attachment_id = att_id
                 and public.can_see_conversation(m.conversation_id))
    -- A freshly uploaded row is visible to its uploader ONLY while it
    -- remains unlinked to anything. Once a row exists linking it to a
    -- project, task, or message, this branch stops applying and
    -- visibility comes solely from the link.
    or exists (
      select 1 from public.attachments a
      where a.id = att_id
        and a.uploaded_by = auth.uid()
        and not exists (select 1 from public.project_attachments pa2
                         where pa2.attachment_id = a.id)
        and not exists (select 1 from public.task_attachments ta2
                         where ta2.attachment_id = a.id)
        and not exists (select 1 from public.message_attachments ma2
                         where ma2.attachment_id = a.id)
    );
$$;

-- ---------------------------------------------------------------------
-- Finding 2 — CONFIRMED, Medium: attachments_update's WITH CHECK was a
-- bare `has_permission('project.create')`, no column restriction. Anyone
-- holding that permission who could currently see an attachment could
-- rewrite uploaded_by to themselves, planting Finding 1's permanent
-- "uploader" fallback on a row they never uploaded. Confirmed live: the
-- rewrite succeeded.
--
-- A WITH CHECK can't compare NEW against OLD, so this needs a trigger --
-- mirrors freeze_created_by's structure on projects/channels
-- (20260906000350_fix_project_policies.sql): BEFORE UPDATE, SECURITY
-- DEFINER, search_path pinned, service_role let through (test/seed
-- helpers only ever set uploaded_by via insert, never reassign it via
-- update, so nothing relies on that bypass).
-- ---------------------------------------------------------------------
create or replace function public.freeze_attachment_uploaded_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.uploaded_by is distinct from old.uploaded_by
     and auth.role() <> 'service_role' then
    raise exception 'uploaded_by cannot be changed after upload';
  end if;
  return new;
end;
$$;

create trigger attachments_freeze_uploaded_by
  before update on public.attachments
  for each row execute function public.freeze_attachment_uploaded_by();

-- Separately, tighten attachments_update's WITH CHECK to re-verify
-- visibility of the post-update row (via can_see_attachment, same as its
-- USING clause) rather than testing only the bare global permission.
-- uploaded_by is now frozen by the trigger above, so this does not
-- change what rows are reachable today, but it stops the WITH CHECK from
-- reading as "any project.create holder may write any attachment they
-- can merely see" and brings it in line with how every other
-- write-visibility check in this migration set is written.
drop policy if exists attachments_update on public.attachments;
create policy attachments_update on public.attachments
  for update to authenticated
  using (public.can_see_attachment(attachments.id) and public.has_permission('project.create'))
  with check (public.can_see_attachment(attachments.id) and public.has_permission('project.create'));

-- ---------------------------------------------------------------------
-- Finding 3 — NOT reproduced (a probe found a user who left a private
-- channel was already blocked from inserting, 42501), fixed
-- defensively: message_attachments_insert/_update/_delete checked only
-- `m.author_id = auth.uid()`, with no live can_see_conversation check,
-- unlike task_attachments_insert/_update/_delete beside it (which AND in
-- can_see_project on top of task.edit/task ownership). Brought into
-- line with that sibling for consistency, requiring the caller both be
-- the message's author AND still able to see its conversation live.
-- ---------------------------------------------------------------------
drop policy if exists message_attachments_insert on public.message_attachments;
create policy message_attachments_insert on public.message_attachments
  for insert to authenticated
  with check (exists (select 1 from public.messages m
                       where m.id = message_attachments.message_id
                         and m.author_id = auth.uid()
                         and public.can_see_conversation(m.conversation_id)));

drop policy if exists message_attachments_update on public.message_attachments;
create policy message_attachments_update on public.message_attachments
  for update to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_attachments.message_id
                    and m.author_id = auth.uid()
                    and public.can_see_conversation(m.conversation_id)))
  with check (exists (select 1 from public.messages m
                       where m.id = message_attachments.message_id
                         and m.author_id = auth.uid()
                         and public.can_see_conversation(m.conversation_id)));

drop policy if exists message_attachments_delete on public.message_attachments;
create policy message_attachments_delete on public.message_attachments
  for delete to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_attachments.message_id
                    and m.author_id = auth.uid()
                    and public.can_see_conversation(m.conversation_id)));
