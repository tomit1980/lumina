-- ---------------------------------------------------------------------
-- Task 10 — file bytes in Storage, and one hardening item carried over
-- from Task 8.
--
-- Two independent things live here because a migration is the only place
-- either can go, and Task 10 is the only remaining task that owns one:
--
--   A. Three private buckets for attachment bytes, with access rules that
--      MIRROR the row policies in 20260906000400_attachments.sql /
--      20260906000450_fix_attachment_policies.sql exactly.
--   B. `roles_block_locked_update` — the trigger recommended by
--      task-8-report.md §5. The database has no opinion today on
--      `roles.locked` / `roles.is_system` during an UPDATE, so a raw
--      PostgREST call from any `members.manage` holder can edit the locked
--      Admin role. Not an escalation (they can already mint an
--      all-permissions role) but a one-way LOCKOUT: revoke
--      `members.manage` from Admin and nobody can ever grant it back.
--
-- ---------------------------------------------------------------------
-- A. Storage
-- ---------------------------------------------------------------------
--
-- WHY THE RULES ARE NOT RE-DERIVED HERE. The whole point of this task is
-- that a file is reachable exactly when the project, task or message it
-- hangs off is. There is already one function that answers precisely that
-- question — `public.can_see_attachment(att_id)` — and it is the function
-- `attachments_read` itself uses. Writing a second copy of the rule
-- against `storage.objects` would be a second thing to keep in step, and
-- this repo has already been burned once by exactly that shape (Task 6:
-- the client pruned collaborators, the server trigger did not, because
-- the rule existed twice). So the policies below CALL the same functions
-- the table policies call. They cannot drift, because there is nothing to
-- drift from.
--
-- THE OBJECT KEY IS THE ATTACHMENT ID. An object's `name` within its
-- bucket is the attachment id and nothing else, so the policy can go from
-- the object to the row it belongs to with no lookup table and no join.
-- Deliberately NOT `<project-id>/<file-name>`: a signed URL exposes its
-- own path to whoever holds it, and a path carrying a project id or a
-- file name would leak both to anyone the link is forwarded to. The
-- download filename travels as a `?download=` parameter on the signed
-- URL instead.
--
-- `attachments.storage_path` stores `<bucket>/<attachment-id>`, so the
-- reference the app carries is self-describing and a delete never has to
-- guess which bucket a file went into.

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('project-files', 'project-files', false, 10485760),
  ('task-files',    'task-files',    false, 10485760),
  ('message-files', 'message-files', false, 10485760)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- The server-side half of MAX_ATTACHMENT_BYTES (lib/attachments.ts). The
-- client checks the size before it uploads so the user gets a sentence
-- rather than a 413; this is what makes the cap true rather than polite.

-- `public = false`: there is no unauthenticated read path at all. Every
-- fetch goes through a signed URL, which storage-api issues only after
-- evaluating the SELECT policy below as the requesting user.

-- ---------------------------------------------------------------------
-- The two things the policies need that the row policies get for free.
-- ---------------------------------------------------------------------

-- The attachment an object belongs to. `split_part` rather than the whole
-- name so that a future `<attachment-id>/<something>` layout keeps
-- working without a policy change; today there is no slash to split on.
create or replace function public.attachment_of_object(object_name text)
returns text
language sql
immutable
as $$ select split_part(object_name, '/', 1) $$;

-- The uploader test, as a function because a policy on `storage.objects`
-- reading `public.attachments` directly would be filtered by the caller's
-- OWN row-level visibility of that table — which is the thing being
-- decided. SECURITY DEFINER for exactly the reason
-- 20260906000400_attachments.sql gives for `can_see_attachment`.
--
-- This is the mirror of `attachments_insert`'s `uploaded_by = auth.uid()`:
-- the attachments row is written first and the bytes second, so at upload
-- time this asks the same question that policy asked a moment earlier.
create or replace function public.is_attachment_uploader(att_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.attachments a
    where a.id = att_id and a.uploaded_by = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------
-- storage.objects — one policy per operation, each the mirror of the
-- `public.attachments` policy for the same operation.
--
-- Scoped to the three buckets by id, so a fourth bucket added later for
-- some unrelated purpose inherits nothing from these.
--
-- `to authenticated` only. The `anon` role therefore matches no policy in
-- any of the three buckets and, with the buckets private, has no other
-- door either: tests/probes/storage_probe.mjs attacks exactly that.
-- ---------------------------------------------------------------------

-- Mirrors `attachments_read`: `can_see_attachment(id)`, no permission of
-- any kind. Reachability is a function of the parent project /
-- conversation, which is the whole requirement.
create policy attachment_objects_read on storage.objects
  for select to authenticated
  using (
    bucket_id in ('project-files', 'task-files', 'message-files')
    and public.can_see_attachment(public.attachment_of_object(name))
  );

-- Mirrors `attachments_insert`: you may only put bytes behind a row you
-- yourself uploaded. Note what this does NOT say — it names no
-- permission. It does not need to: the *link* that makes the file part of
-- a project, a task or a message is a separate insert into
-- project_attachments / task_attachments / message_attachments, and those
-- policies carry the permission checks (project_is_manageable,
-- has_permission('task.edit'), message authorship). Bytes with no link
-- are visible to their uploader and to nobody else.
create policy attachment_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('project-files', 'task-files', 'message-files')
    and public.is_attachment_uploader(public.attachment_of_object(name))
  );

-- Mirrors `attachments_update` (as amended by
-- 20260906000450_fix_attachment_policies.sql): visible AND
-- `project.create`. This is the in-app document editors' save path, and
-- `project.create` is exactly what `updateProject` guards on in
-- lib/store.tsx — see task-10-report.md for the full guard/policy
-- comparison.
create policy attachment_objects_update on storage.objects
  for update to authenticated
  using (
    bucket_id in ('project-files', 'task-files', 'message-files')
    and public.can_see_attachment(public.attachment_of_object(name))
    and public.has_permission('project.create')
  )
  with check (
    bucket_id in ('project-files', 'task-files', 'message-files')
    and public.can_see_attachment(public.attachment_of_object(name))
    and public.has_permission('project.create')
  );

-- Mirrors `attachments_delete`: the uploader, or `project.delete`.
--
-- ORDERING, and it is the Storage form of the rule Task 6 learned the
-- hard way. Both this policy and `attachments_delete` are answered from
-- the `attachments` row. Delete that row first and this predicate can
-- never be satisfied again by anyone — `is_attachment_uploader` returns
-- false for a row that is gone — so the bytes would be stranded in the
-- bucket forever. lib/backend/supabase/storage.ts therefore deletes the
-- OBJECT first and the row second. That order is safe precisely because
-- the two predicates are identical: if the object delete was allowed, the
-- row delete is allowed too, against the same unchanged state.
create policy attachment_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('project-files', 'task-files', 'message-files')
    and (
      public.is_attachment_uploader(public.attachment_of_object(name))
      or public.has_permission('project.delete')
    )
  );

-- ---------------------------------------------------------------------
-- B. `roles.locked` / `roles.is_system` on UPDATE
--     (task-8-report.md §5, "Recommended follow-up")
--
-- Shaped after `block_role_delete_with_members` (20260906000500) for the
-- raise, and after `freeze_attachment_uploaded_by` (20260906000450) for
-- the service_role bypass. The bypass is load-bearing, not decorative:
-- tests/helpers/workspace.ts's `seedRoles()` upserts all three built-in
-- roles from DEFAULT_ROLES on every RLS file, and an upsert of an
-- existing row is an UPDATE. Without the bypass this trigger would break
-- the entire RLS suite's fixtures rather than the attack it exists to
-- stop. Every real caller reaches this table as `authenticated`.
--
-- Two separate rules, because they fail for different reasons:
--   1. a locked role may not be edited at all — the lockout above;
--   2. `is_system` / `locked` may not be changed on ANY role, or rule 1
--      is one UPDATE away from being switched off, and a role promoted to
--      `is_system` becomes permanently undeletable
--      (`block_role_delete_with_members` refuses built-ins).
-- ---------------------------------------------------------------------
create or replace function public.block_locked_role_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
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

create trigger roles_block_locked_update
  before update on public.roles
  for each row execute function public.block_locked_role_update();
